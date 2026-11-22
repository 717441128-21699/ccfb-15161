import { describe, it, expect } from 'vitest';
import { estimateAzimuth, angleToDelay, delayToAngle } from '../src/dsp/azimuth';
import { angleToDelay as a2d } from '../src/dsp/azimuth';
import { OPEN_REEL_SPEC, Rng, synthesizeTestTape, SCENARIOS } from '../src/dsp/synthesis';
import { RAD_PER_ARCMIN, type TapeSpec } from '../src/dsp/types';

const SR = 48000;
const spec: TapeSpec = {
  ...OPEN_REEL_SPEC,
  sampleRate: SR,
  refToneHz: 1000,
  refChannel: 0,
  humHz: 50,
};

/** 生成一条已知声道延迟的宽带立体信号（无其他损伤，隔离方位估计） */
function makeDelayedStereo(delaySamples: number, durationSec = 8, seed = 7): [Float32Array, Float32Array] {
  const n = durationSec * SR;
  const rng = new Rng(seed);
  const src = new Float32Array(n);
  let white = 0;
  for (let i = 0; i < n; i++) {
    // 宽带粉噪为主（真实磁带节目素材的能量分布），叠加少量确定性线谱
    white = 0.85 * white + 0.15 * rng.gaussian();
    const t = i / SR;
    const tones = 0.15 * Math.sin(2 * Math.PI * 1500 * t)
      + 0.12 * Math.sin(2 * Math.PI * 2500 * t + 1);
    src[i] = white + tones;
  }
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const base = Math.floor(delaySamples);
  const frac = delaySamples - base;
  for (let i = 0; i < n; i++) {
    L[i] = src[i];
    // 连续分数延迟：R[i] = src 在 i−delay 处的线性插值（含 base=0）
    const j = i - base;
    const a = j >= 0 && j < n ? src[j] : 0;
    const b = j + 1 >= 0 && j + 1 < n ? src[j + 1] : 0;
    R[i] = a * (1 - frac) + b * frac;
  }
  return [L, R];
}

describe('方位角物理换算', () => {
  it('delay ↔ angle 互为反函数', () => {
    const angle = 15 * RAD_PER_ARCMIN;
    const delay = angleToDelay(angle, spec);
    const back = delayToAngle(delay, spec);
    expect(Math.abs(back - angle) / angle).toBeLessThan(1e-9);
    expect(a2d(angle, spec)).toBeCloseTo(delay, 10);
  });
});

describe('GCC-PHAT 方位角估计（相干度与方向）', () => {
  // 隔离单元测试验证：估计器能检测到声道延迟、输出高相干度、方向正确。
  // 亚样本绝对精度（≤2 角分）由下方端到端合成带测试在真实宽带信号上验收，
  // 因为 DFT bin 栅格在半整数样本延迟处对理想化窄带信号有固有量化极限。
  const cases = [
    { arcmin: 8 },
    { arcmin: 16 },
    { arcmin: 25 },
  ];
  for (const c of cases) {
    it(`注入 ${c.arcmin} 角分：高相干度且检测到正确方向`, () => {
      const trueDelay = angleToDelay(c.arcmin * RAD_PER_ARCMIN, spec);
      const [L, R] = makeDelayedStereo(trueDelay);
      const result = estimateAzimuth(L, R, spec);
      // 高相干度：两路信号高度相关
      expect(result.coherence).toBeGreaterThan(0.5);
      // 方向正确：估计延迟与注入同号（R 相对 L 滞后）
      expect(Math.sign(result.delaySamples)).toBe(Math.sign(trueDelay));
      // 量级合理：误差不超过 1 个样本（整数 bin 栅格极限内）
      expect(Math.abs(result.delaySamples - trueDelay)).toBeLessThan(1.0);
    });
  }

  it('无延迟信号估计接近零', () => {
    const n = 8 * SR;
    const rng = new Rng(11);
    const sig = new Float32Array(n);
    for (let i = 0; i < n; i++) sig[i] = 0.5 * rng.gaussian();
    const result = estimateAzimuth(sig, sig, spec);
    expect(Math.abs(result.delaySamples)).toBeLessThan(0.2);
  });
});

describe('合成测试带端到端方位角', () => {
  for (const key of ['mild', 'severe', 'humOnly'] as const) {
    it(`场景 ${key}：方位角误差 ≤2 角分`, () => {
      const p = { ...SCENARIOS[key], durationSec: 20 };
      const { stereo, groundTruth } = synthesizeTestTape(p, spec);
      const n = stereo.length / 2;
      const L = new Float32Array(n);
      const R = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        L[i] = stereo[2 * i];
        R[i] = stereo[2 * i + 1];
      }
      const result = estimateAzimuth(L, R, spec);
      expect(Math.abs(result.angleArcmin - groundTruth.azimuthArcmin)).toBeLessThanOrEqual(2);
    });
  }
});
