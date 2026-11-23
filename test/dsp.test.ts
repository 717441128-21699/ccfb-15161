import { describe, it, expect } from 'vitest';
import {
  synthesizeTape,
  WARP_PRESETS,
  AZIMUTH_PRESETS,
  type SynthesisSpec,
} from '../src/dsp/synthesis';
import { trackRate, smoothRateMap } from '../src/dsp/tracker';
import { estimateAzimuth } from '../src/dsp/azimuth';
import { resampleChannelDense } from '../src/dsp/resample';
import { runPipelineTs } from '../src/dsp/pipeline';
import {
  azimuthToDelaySeconds,
  delaySecondsToAzimuth,
  ARCMIN_TO_RAD,
  RAD_TO_ARCMIN,
  gapWidthFromLossAt10k,
  gapLossLinear,
  TAPE_SPEED_MPS,
} from '../src/dsp/constants';
import { designStereoPlan } from '../src/dsp/filterDesign';
import { fftInPlace } from '../src/dsp/fft';
import { measureResponse, responseAtFreq, convolveDirect, convolveOverlapSave } from '../src/dsp/fir';

const FS = 48000;

function baseSpec(overrides: Partial<SynthesisSpec> = {}): SynthesisSpec {
  return {
    sampleRate: FS,
    durationSeconds: 20,
    warp: WARP_PRESETS.moderate,
    azimuth: AZIMUTH_PRESETS.offset,
    hum: { baseHz: 50, level: 0.01, harmonics: [1, 2, 3] },
    referenceToneHz: 1000,
    referenceLevel: 0.18,
    noiseLevel: 0.004,
    seed: 20261123,
    ...overrides,
  };
}

describe('物理常量与几何换算', () => {
  it('方位角 ↔ 延迟互逆', () => {
    for (const arcmin of [-60, -30, -10, 0, 10, 30, 60]) {
      const theta = arcmin * ARCMIN_TO_RAD;
      const delay = azimuthToDelaySeconds(theta);
      const back = delaySecondsToAzimuth(delay) * RAD_TO_ARCMIN;
      expect(Math.abs(back - arcmin)).toBeLessThan(1e-9);
    }
  });

  it('缝隙损耗反解在 10kHz 自洽', () => {
    for (const db of [3, 5, 8, 12]) {
      const gap = gapWidthFromLossAt10k(db);
      const loss = gapLossLinear(10000, gap, TAPE_SPEED_MPS);
      expect(Math.abs(20 * Math.log10(loss) + db)).toBeLessThan(0.01);
    }
  });
});

describe('抖晃跟踪', () => {
  it.each([
    ['轻度', WARP_PRESETS.mild, 0.9],
    ['中度', WARP_PRESETS.moderate, 0.9],
    ['重度', WARP_PRESETS.severe, 0.5],
  ])('%s抖晃下跟踪速率与真值点级相关且均值无偏', (_name, warp, corrThreshold) => {
    const tape = synthesizeTape(baseSpec({ warp, durationSeconds: 30 }));
    const tracked = trackRate(tape.degraded.left, {
      sampleRate: FS,
      referenceHz: 1000,
      harmonics: [1],
      frameSize: 2048,
    });
    // 点级真值（每个跟踪点时刻的实际速率），这是跟踪器的真实输出粒度
    const est = tracked.points.map((p) => p.rate);
    const truth = tracked.points.map((p) =>
      tape.rates[Math.min(tape.rates.length - 1, Math.floor(p.t * FS))],
    );
    const mt = truth.reduce((a, b) => a + b, 0) / truth.length;
    const me = est.reduce((a, b) => a + b, 0) / est.length;
    let num = 0, dt = 0, de = 0;
    for (let i = 0; i < est.length; i++) {
      num += (truth[i] - mt) * (est[i] - me);
      dt += (truth[i] - mt) ** 2;
      de += (est[i] - me) ** 2;
    }
    const corr = num / Math.sqrt(dt * de);
    expect(corr).toBeGreaterThan(corrThreshold);
    // 均值偏差 < 0.5%（重度场景放宽）
    expect(Math.abs(me - mt)).toBeLessThan(0.005);
  });

  it('无参考音时可用 50Hz 哼声谐波跟踪', () => {
    const tape = synthesizeTape(
      baseSpec({
        referenceToneHz: 0,
        referenceLevel: 0,
        hum: { baseHz: 50, level: 0.03, harmonics: [1, 2, 3, 4] },
        durationSeconds: 30,
      }),
    );
    const tracked = trackRate(tape.degraded.left, {
      sampleRate: FS,
      referenceHz: 50,
      harmonics: [1, 2, 3, 4],
      frameSize: 4096,
    });
    const rates = smoothRateMap(tracked.ratesPerSecond);
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    expect(Math.abs(mean - 1)).toBeLessThan(0.005);
  });
});

describe('方位角估计', () => {
  it.each([
    ['对齐', 0],
    ['轻微 10 角分', 10],
    ['偏差 30 角分', 30],
    ['严重 60 角分', 60],
    ['负偏 -25 角分', -25],
  ])('%s：估计误差不超过 2 角分', (_name, arcmin) => {
    const tape = synthesizeTape(
      baseSpec({
        azimuth: { arcmin, lossDbAt10k: 8 },
        warp: WARP_PRESETS.mild,
        durationSeconds: 8,
      }),
    );
    const est = estimateAzimuth(tape.degraded.left, tape.degraded.right, {
      sampleRate: FS,
      fftSize: 2048,
      maxFrames: 48,
    });
    expect(Math.abs(est.thetaArcmin - arcmin)).toBeLessThanOrEqual(2);
  });

  it('有噪声与抖晃时仍稳定（多场景重复）', () => {
    for (const warp of [WARP_PRESETS.mild, WARP_PRESETS.moderate, WARP_PRESETS.severe]) {
      const tape = synthesizeTape(baseSpec({ warp, azimuth: AZIMUTH_PRESETS.slight, durationSeconds: 8 }));
      const est = estimateAzimuth(tape.degraded.left, tape.degraded.right, { sampleRate: FS });
      expect(Math.abs(est.thetaArcmin - 10)).toBeLessThanOrEqual(2);
    }
  });
});

describe('高频补偿', () => {
  it.each([3, 5, 8, 12])('10kHz 衰减 %idB 修复后与参考带相差 ≤1dB', (lossDb) => {
    const tape = synthesizeTape(
      baseSpec({
        azimuth: { arcmin: 20, lossDbAt10k: lossDb },
        warp: WARP_PRESETS.mild,
        // 深度补偿会抬升高频本底，较长信号让周期图平均更稳定
        durationSeconds: 16,
      }),
    );
    // 干净带作为“参考带”基准
    const refResp = measureResponse(tape.clean.left, FS, 8192, { fft: fftInPlace });
    const ref1k = (responseAtFreq(refResp.freqs, refResp.magnitudeDb, 900) +
      responseAtFreq(refResp.freqs, refResp.magnitudeDb, 1100)) / 2;
    const ref10k = responseAtFreq(refResp.freqs, refResp.magnitudeDb, 10000);

    const plan = designStereoPlan(tape.trueDelaySeconds, lossDb, FS, 161);
    const restored = convolveDirect(tape.degraded.left, plan.left.combined);
    const resp = measureResponse(restored, FS, 8192, { fft: fftInPlace });
    const got1k = (responseAtFreq(resp.freqs, resp.magnitudeDb, 900) +
      responseAtFreq(resp.freqs, resp.magnitudeDb, 1100)) / 2;
    const got10k = responseAtFreq(resp.freqs, resp.magnitudeDb, 10000);

    // 修复后 10k 相对 1k 的形状，与参考带同口径比较
    const restoredShape = got10k - got1k;
    const referenceShape = ref10k - ref1k;
    expect(Math.abs(restoredShape - referenceShape)).toBeLessThanOrEqual(1);
  });

  it('overlap-save 与直接卷积一致', () => {
    const plan = designStereoPlan(0.00002, 6, FS, 65);
    const input = new Float64Array(8000).map((_, i) => Math.sin(0.02 * i) * 0.5);
    const a = convolveDirect(input, plan.left.combined);
    const b = convolveOverlapSave(input, plan.left.combined, { fft: fftInPlace });
    let err = 0;
    for (let i = 0; i < a.length; i++) err = Math.max(err, Math.abs(a[i] - b[i]));
    expect(err).toBeLessThan(1e-9);
  });
});

describe('端到端 TS 流水线', () => {
  it('修复后方位角与高频指标同时达标', () => {
    const tape = synthesizeTape(baseSpec({ durationSeconds: 12 }));
    // 以干净带频谱作为参考基准（实际使用时由校准带提供）
    const referenceResponse = measureResponse(tape.clean.left, FS, 8192, { fft: fftInPlace });
    const result = runPipelineTs(
      {
        sampleRate: FS,
        channels: [tape.degraded.left, tape.degraded.right],
        reference: referenceResponse,
      },
      { referenceHz: 1000, useHum: false, humHz: 50, taps: 161, maxBoostDb: 12 },
    );
    expect(Math.abs(result.metrics.azimuthArcmin - AZIMUTH_PRESETS.offset.arcmin)).toBeLessThanOrEqual(2);
    expect(Math.abs(result.metrics.residualDbAt10k)).toBeLessThanOrEqual(1);
  });

  it('重采样把参考音频率拉回额定值', () => {
    const tape = synthesizeTape(baseSpec({ durationSeconds: 10 }));
    // 用真值速率直接校正，验证重采样本身
    const corrected = resampleChannelDense(tape.degraded.left, tape.rates);
    const resp = measureResponse(corrected, FS, 16384, { fft: fftInPlace });
    // 抖晃使单一峰会展宽，用 800–1200Hz 带内功率质心衡量平均频率
    let wsum = 0;
    let fsum = 0;
    for (let k = 0; k < resp.freqs.length; k++) {
      if (resp.freqs[k] >= 800 && resp.freqs[k] <= 1200) {
        const w = Math.pow(10, resp.magnitudeDb[k] / 10);
        wsum += w;
        fsum += w * resp.freqs[k];
      }
    }
    const centroid = fsum / wsum;
    expect(Math.abs(centroid - 1000)).toBeLessThan(4);
  });
});
