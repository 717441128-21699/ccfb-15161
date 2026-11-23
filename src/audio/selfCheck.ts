/**
 * Worklet 浏览器自检：在 OfflineAudioContext 中跑三个 AudioWorklet，
 * 与 TypeScript 参考实现交叉比对，验证 worklet 端算法移植正确。
 * 该模块由 UI 的“自检”入口调用，也可在浏览器控制台手动运行。
 */
import { synthesizeTape, WARP_PRESETS, AZIMUTH_PRESETS } from '../dsp/synthesis';
import { trackRate } from '../dsp/tracker';
import { estimateAzimuth } from '../dsp/azimuth';
import { runTrackerOffline, runAzimuthOffline, runFirOffline } from '../audio/workletEngine';
import { designStereoPlan } from '../dsp/filterDesign';
import { convolveOverlapSave } from '../dsp/fir';
import { fftInPlace } from '../dsp/fft';

export interface SelfCheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

function toBuffer(channels: Float64Array[], sampleRate: number): AudioBuffer {
  const ctx = new OfflineAudioContext(2, channels[0].length, sampleRate);
  const buf = ctx.createBuffer(2, channels[0].length, sampleRate);
  buf.copyToChannel(Float32Array.from(channels[0]), 0);
  buf.copyToChannel(Float32Array.from(channels[1]), 1);
  return buf;
}

export async function runWorkletSelfCheck(onLog?: (r: SelfCheckResult) => void): Promise<SelfCheckResult[]> {
  const results: SelfCheckResult[] = [];
  const log = (r: SelfCheckResult) => { results.push(r); onLog?.(r); };

  const fs = 48000;
  const tape = synthesizeTape({
    sampleRate: fs,
    durationSeconds: 6,
    warp: WARP_PRESETS.moderate,
    azimuth: AZIMUTH_PRESETS.offset,
    hum: { baseHz: 50, level: 0.01, harmonics: [1, 2, 3] },
    referenceToneHz: 1000,
    referenceLevel: 0.18,
    noiseLevel: 0.004,
    seed: 31415,
  });
  const buffer = toBuffer([tape.degraded.left, tape.degraded.right], fs);

  // 1. 跟踪 Worklet vs TS
  try {
    const [wl, ts] = await Promise.all([
      runTrackerOffline(buffer, 1000, [1], 2048),
      Promise.resolve(trackRate(tape.degraded.left, { sampleRate: fs, referenceHz: 1000, harmonics: [1], frameSize: 2048 })),
    ]);
    // 比较秒级速率均值
    const wlMean = Array.from(wl.ratesPerSecond).reduce((a, b) => a + b, 0) / wl.ratesPerSecond.length;
    const tsMean = Array.from(ts.ratesPerSecond).reduce((a, b) => a + b, 0) / ts.ratesPerSecond.length;
    const diff = Math.abs(wlMean - tsMean);
    log({
      name: '抖晃跟踪 Worklet',
      pass: diff < 0.005,
      detail: `Worklet 均值速率 ${wlMean.toFixed(5)}，TS ${tsMean.toFixed(5)}，偏差 ${(diff * 100).toFixed(3)}%`,
    });
  } catch (e) {
    log({ name: '抖晃跟踪 Worklet', pass: false, detail: (e as Error).message });
  }

  // 2. 方位角 Worklet vs TS
  try {
    const [wl, ts] = await Promise.all([
      runAzimuthOffline(buffer, { fftSize: 2048, maxFrames: 48 }),
      Promise.resolve(estimateAzimuth(tape.degraded.left, tape.degraded.right, { sampleRate: fs, fftSize: 2048, maxFrames: 48 })),
    ]);
    const wlArc = Math.atan((wl.delaySeconds * 0.0476) / 0.65e-3) * (180 * 60 / Math.PI);
    const diff = Math.abs(wlArc - ts.thetaArcmin);
    log({
      name: '方位角估计 Worklet',
      pass: diff < 2,
      detail: `Worklet ${wlArc.toFixed(2)}′，TS ${ts.thetaArcmin.toFixed(2)}′，真值 ${AZIMUTH_PRESETS.offset.arcmin}′，偏差 ${diff.toFixed(2)}′`,
    });
  } catch (e) {
    log({ name: '方位角估计 Worklet', pass: false, detail: (e as Error).message });
  }

  // 3. FIR Worklet vs TS overlap-save
  try {
    const plan = designStereoPlan(tape.trueDelaySeconds, AZIMUTH_PRESETS.offset.lossDbAt10k, fs, 161);
    const wlBuf = await runFirOffline(buffer, plan.left.combined, plan.right.combined);
    const tsOut = convolveOverlapSave(tape.degraded.left, plan.left.combined, { fft: fftInPlace });
    // 跳过 FIR 群延迟边缘，比较稳态段最大误差
    const skip = 200;
    let maxErr = 0;
    const wlData = wlBuf.getChannelData(0);
    for (let i = skip; i < Math.min(tsOut.length, wlData.length) - skip; i++) {
      maxErr = Math.max(maxErr, Math.abs(wlData[i] - tsOut[i]));
    }
    log({
      name: 'FIR 滤波 Worklet',
      pass: maxErr < 0.02,
      detail: `与 TS overlap-save 稳态最大样本误差 ${maxErr.toExponential(2)}`,
    });
  } catch (e) {
    log({ name: 'FIR 滤波 Worklet', pass: false, detail: (e as Error).message });
  }

  return results;
}
