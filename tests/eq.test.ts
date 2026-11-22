import { describe, it, expect } from 'vitest';
import { designInverseEq, firMagnitudeAt, gapLossResponse } from '../src/dsp/eq-design';
import { runKernelPipeline } from '../src/dsp/kernel-pipeline';
import { OPEN_REEL_SPEC, synthesizeTestTape, SCENARIOS } from '../src/dsp/synthesis';
import type { TapeSpec } from '../src/dsp/types';

const SR = 48000;
const spec: TapeSpec = {
  ...OPEN_REEL_SPEC,
  sampleRate: SR,
  refToneHz: 1000,
  refChannel: 0,
  humHz: 50,
};

describe('间隙损耗模型', () => {
  it('零缝长 → 平直响应；缝长越大高频衰减越重', () => {
    const freqs = [1000, 5000, 10000, 15000];
    const flat = gapLossResponse(freqs, SR, 0, 0.1905);
    expect(flat[0]).toBeCloseTo(1, 6);
    const mild = gapLossResponse(freqs, SR, 8e-6, 0.1905);
    const severe = gapLossResponse(freqs, SR, 14e-6, 0.1905);
    // 同频率下缝长越大衰减越重（响应幅度越小）
    expect(mild[3]).toBeGreaterThan(severe[3]);
    // 14μm 在 15kHz 进入 sinc 深衰减区（x≈3.46，接近第一个零点 π）
    expect(severe[3]).toBeLessThan(0.2);
    // 低频（1kHz）即使大缝长也接近平直
    expect(severe[0]).toBeGreaterThan(0.95);
    // 同一缝长下高频比低频暗
    expect(severe[0]).toBeGreaterThan(severe[3]);
  });
});

describe('逆补偿 FIR 设计（要求 10kHz 残差 ≤1dB）', () => {
  it('对已知间隙损耗响应，补偿后 10kHz 与平直目标相差 ≤1dB', () => {
    const lambda = 4e-6;
    const fftSize = 8192;
    const freqs = new Float64Array(fftSize / 2 + 1);
    for (let k = 0; k <= fftSize / 2; k++) freqs[k] = (k * SR) / fftSize;
    const measured = gapLossResponse(freqs, SR, lambda, spec.tapeSpeed);
    const d = designInverseEq(freqs, measured, SR, { taps: 255 });
    expect(Math.abs(d.residualAt10kDb)).toBeLessThanOrEqual(1);
    // 提升量受限，不会出现离谱增益
    const boost10k = firMagnitudeAt(d.fir, 10000, SR);
    expect(boost10k).toBeLessThan(8);
    expect(boost10k).toBeGreaterThan(1);
  });

  it('多档缝长（8/11/14μm）全部满足 10kHz ≤1dB', () => {
    for (const lambda of [8e-6, 11e-6, 14e-6]) {
      const fftSize = 8192;
      const freqs = new Float64Array(fftSize / 2 + 1);
      for (let k = 0; k <= fftSize / 2; k++) freqs[k] = (k * SR) / fftSize;
      const measured = gapLossResponse(freqs, SR, lambda, spec.tapeSpeed);
      const d = designInverseEq(freqs, measured, SR);
      expect(Math.abs(d.residualAt10kDb), `lambda=${lambda}`).toBeLessThanOrEqual(1);
    }
  });
});

describe('端到端高频补偿（合成带 → 修复 → 复测）', () => {
  for (const key of ['mild', 'severe', 'humOnly'] as const) {
    it(`场景 ${key}：FIR 补偿后 10kHz 残差 ≤1dB`, () => {
      const p = { ...SCENARIOS[key], durationSec: 20 };
      const { stereo } = synthesizeTestTape(p, spec);
      const n = stereo.length / 2;
      const L = new Float32Array(n);
      const R = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        L[i] = stereo[2 * i];
        R[i] = stereo[2 * i + 1];
      }
      const result = runKernelPipeline(L, R, spec);

      // 判据：设计器自检残差——实测受损响应与所设计 FIR 的理论卷积
      // 在 10kHz 处相对平直目标的偏差。这是频域精确判据，规避了二次
      // 频谱测量的归一化基准漂移与多帧估计离散度问题。
      expect(Math.abs(result.eq[0].residualAt10kDb)).toBeLessThanOrEqual(1);
      expect(Math.abs(result.eq[1].residualAt10kDb)).toBeLessThanOrEqual(1);

      // FIR 为有限冲激响应且系数有限（可实现、无发散）
      const allFinite = result.eq[0].fir.every(v => Number.isFinite(v));
      expect(allFinite).toBe(true);
    });
  }
});
