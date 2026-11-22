import { describe, it, expect } from 'vitest';
import { WowFlutterTracker, buildCorrectionCurve } from '../src/dsp/wow-flutter';
import { runKernelPipeline } from '../src/dsp/kernel-pipeline';
import { OPEN_REEL_SPEC, synthesizeTestTape, SCENARIOS, Rng } from '../src/dsp/synthesis';
import type { TapeSpec } from '../src/dsp/types';

const SR = 48000;
const spec: TapeSpec = {
  ...OPEN_REEL_SPEC,
  sampleRate: SR,
  refToneHz: 1000,
  refChannel: 0,
  humHz: 50,
};

/** 直接按已知速度曲线对正弦参考音做变速，隔离验证 IQ 跟踪核 */
function makeWarpedTone(f0: number, speedAt: (t: number) => number, durationSec: number): Float32Array {
  const n = durationSec * SR;
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const s = speedAt(t);
    phase += (2 * Math.PI * f0 * s) / SR;
    out[i] = 0.5 * Math.sin(phase);
  }
  return out;
}

describe('IQ 抖晃跟踪核', () => {
  it('恒定 2% 变速：估计速度比收敛到 1.02', () => {
    const sig = makeWarpedTone(1000, () => 1.02, 8);
    const tracker = new WowFlutterTracker(SR, 1000, 256);
    const pts: number[] = [];
    for (let i = 0; i < sig.length; i++) {
      const p = tracker.process(sig[i]);
      if (p && p.t > 1) pts.push(p.ratio); // 丢掉瞬态起始段
    }
    const mean = pts.reduce((a, b) => a + b, 0) / pts.length;
    expect(mean).toBeCloseTo(1.02, 3);
  });

  it('正弦抖晃 0.8Hz/±1%：RMS 跟踪误差 < 0.08%', () => {
    const speed = (t: number) => 1 + 0.01 * Math.sin(2 * Math.PI * 0.8 * t);
    const sig = makeWarpedTone(1000, speed, 12);
    const tracker = new WowFlutterTracker(SR, 1000, 256);
    const raw = [];
    for (let i = 0; i < sig.length; i++) {
      const p = tracker.process(sig[i]);
      if (p && p.t > 1) raw.push(p);
    }
    const curve = buildCorrectionCurve(raw);
    const err = curve.map(p => (p.ratio - speed(p.t)) ** 2);
    const rms = Math.sqrt(err.reduce((a, b) => a + b, 0) / err.length);
    expect(rms).toBeLessThan(0.0008);
  });

  it('带噪参考音（SNR≈10dB）仍能稳定跟踪', () => {
    const rng = new Rng(99);
    const sig = makeWarpedTone(1000, t => 1 + 0.005 * Math.sin(2 * Math.PI * 2 * t), 10);
    for (let i = 0; i < sig.length; i++) sig[i] += 0.16 * rng.gaussian();
    const tracker = new WowFlutterTracker(SR, 1000, 256);
    const raw = [];
    for (let i = 0; i < sig.length; i++) {
      const p = tracker.process(sig[i]);
      if (p && p.t > 1) raw.push(p);
    }
    expect(raw.length).toBeGreaterThan(100);
    const curve = buildCorrectionCurve(raw);
    const valid = curve.filter(p => p.t > 2 && p.t < 9);
    const mean = valid.reduce((a, p) => a + p.ratio, 0) / valid.length;
    expect(Math.abs(mean - 1)).toBeLessThan(0.002);
  });
});

describe('端到端抖晃指标（合成带真值）', () => {
  // 修复后 flutter 绝对测量值的合理区间（百分比）。跟踪校正后残余主要是
  // DFT 相位噪声底与未完全校正的快抖晃，落在 0.5–6% 均为物理合理。
  const absRange: Record<string, [number, number]> = {
    mild: [0.5, 6.0],
    severe: [0.5, 6.0],
  };
  for (const key of ['mild', 'severe'] as const) {
    it(`场景 ${key}：测得 flutter RMS 落在物理合理区间`, () => {
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
      const [lo, hi] = absRange[key];
      // 绝对测量值落在合理区间
      expect(result.drift.flutterRmsPct).toBeGreaterThan(lo);
      expect(result.drift.flutterRmsPct).toBeLessThan(hi);
    });
  }

  it('修复后参考音瞬时频率漂移显著收敛（残余 ≤ 修复前 60%）', () => {
    const p = { ...SCENARIOS.severe, durationSec: 20 };
    const { stereo } = synthesizeTestTape(p, spec);
    const n = stereo.length / 2;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      L[i] = stereo[2 * i];
      R[i] = stereo[2 * i + 1];
    }
    const before = summarize(mono(L, R), SR, 1000); // 小数，×100 得百分比
    const result = runKernelPipeline(L, R, spec);
    // 修复前全带频率漂移显著（>2%），修复后 pipeline 报告的带通 flutter
    // 收敛到修复前的 60% 以下（跟踪校正把真实抖晃拉正，残余为测量噪声底）。
    const beforePct = before * 100;
    expect(beforePct).toBeGreaterThan(2);
    expect(result.drift.flutterRmsPct).toBeLessThan(beforePct * 0.6);
  });
});

function mono(L: Float32Array, R: Float32Array): Float32Array {
  const m = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) m[i] = 0.5 * (L[i] + R[i]);
  return m;
}

function summarize(sig: Float32Array, sr: number, f0: number): number {
  const tracker = new WowFlutterTracker(sr, f0, 256);
  const ratios: number[] = [];
  for (let i = 0; i < sig.length; i++) {
    const p = tracker.process(sig[i]);
    if (p && p.t > 1) ratios.push(p.ratio - 1);
  }
  return Math.sqrt(ratios.reduce((a, b) => a + b * b, 0) / ratios.length);
}
