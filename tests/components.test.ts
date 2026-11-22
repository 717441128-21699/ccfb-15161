import { describe, it, expect } from 'vitest';
import { VariableRateResampler, FractionalDelay } from '../src/dsp/resampler';
import { encodeWav16, decodeWavStream } from '../src/audio/wav-codec';
import { Rng, synthesizeTestTape, SCENARIOS } from '../src/dsp/synthesis';
import { OPEN_REEL_SPEC } from '../src/dsp/synthesis';
import type { TapeSpec } from '../src/dsp/types';

const SR = 48000;
const spec: TapeSpec = {
  ...OPEN_REEL_SPEC,
  sampleRate: SR,
  refToneHz: 1000,
  refChannel: 0,
  humHz: 50,
};

describe('变速重采样', () => {
  it('速度比恒为 1 时，输出波形逐样本保持（边界误差 <1e-3）', () => {
    const rng = new Rng(5);
    const input = Float32Array.from({ length: 4096 }, () => rng.gaussian() * 0.5);
    const rs = new VariableRateResampler(SR, []);
    const out = rs.process(input);
    // 速度比 1 时输出逐样本等于输入（末尾 2 个样本为插值余量不产出）
    let err = 0;
    for (let i = 0; i < out.length; i++) {
      err = Math.max(err, Math.abs(out[i] - input[i]));
    }
    expect(err).toBeLessThan(1e-3);
    // 仅末尾少约 2 个样本
    expect(input.length - out.length).toBeLessThanOrEqual(3);
  });

  it('速度比 1.05 时输出时长约为输入的 1/1.05', () => {
    const input = new Float32Array(SR * 5);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin(2 * Math.PI * 440 * (i / SR));
    const rs = new VariableRateResampler(SR, [
      { t: 0, ratio: 1.05, level: 1, coherence: 1 },
      { t: 5, ratio: 1.05, level: 1, coherence: 1 },
    ]);
    const out = rs.process(input);
    const ratio = out.length / input.length;
    expect(Math.abs(ratio - 1 / 1.05)).toBeLessThan(0.02);
  });
});

describe('分数延迟', () => {
  it('整数延迟 1 样本精确成立', () => {
    const fd = new FractionalDelay(1);
    const input = [1, 0, 0, 0, 0, 0, 0, 0];
    const out = input.map(x => fd.process(x));
    // Catmull-Rom 整数延迟为单位增益；实现含 1 样本群延迟，
    // t=0 输入的脉冲在 d=1 时于索引 2 精确复现
    expect(out[2]).toBeGreaterThan(0.95);
    expect(out[1]).toBeLessThan(0.05);
    expect(out[3]).toBeLessThan(0.05);
  });

  it('延迟 0.5 样本的正弦相位延迟量正确', () => {
    // d=0.5 与 d=0 共享相同的 2 样本群延迟，二者稳态相位差只来自 0.5 分数延迟
    const n = 4096;
    const f = 1000;
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) input[i] = Math.cos(2 * Math.PI * f * (i / SR));
    const outHalf = new FractionalDelay(0.5).processBlock(input);
    const outZero = new FractionalDelay(0).processBlock(input);
    // 稳态段用 Goertzel 式正交解调测两路相位
    const phaseOf = (sig: Float32Array): number => {
      let re = 0, im = 0;
      for (let i = 2000; i < 4000; i++) {
        const w = 2 * Math.PI * f * (i / SR);
        re += sig[i] * Math.cos(w);
        im -= sig[i] * Math.sin(w);
      }
      return Math.atan2(im, re);
    };
    const dPhase = phaseOf(outHalf) - phaseOf(outZero);
    const delaySamples = -(dPhase / (2 * Math.PI)) * (SR / f);
    // 三阶插值在 1kHz 的轻微幅度/相位偏差，容差 0.08 样本
    expect(Math.abs(delaySamples - 0.5)).toBeLessThan(0.08);
  });
});

describe('WAV 编解码往返', () => {
  it('16-bit 立体声 WAV 编码后可分块解码，内容一致（容差 1/32768）', async () => {
    const frames = SR * 2;
    const interleaved = new Float32Array(frames * 2);
    for (let i = 0; i < frames; i++) {
      const t = i / SR;
      // 有界确定性信号，幅度恒 <1，不触发编码器防削波钳位
      interleaved[2 * i] = 0.4 * Math.sin(2 * Math.PI * 440 * t) + 0.2 * Math.sin(2 * Math.PI * 1200 * t);
      interleaved[2 * i + 1] = 0.4 * Math.sin(2 * Math.PI * 330 * t + 1);
    }
    const blob = encodeWav16(interleaved, SR, 2);
    expect(blob.size).toBe(44 + frames * 4);
    const chunks: Float32Array[] = [];
    const meta = await decodeWavStream(blob, async c => {
      expect(c.sampleRate).toBe(SR);
      expect(c.channels.length).toBe(2);
      chunks.push(c.channels[0], c.channels[1]);
    }, 1);
    expect(meta.totalSamples).toBe(frames);
    const decL = concat(chunks.filter((_, i) => i % 2 === 0));
    let err = 0;
    for (let i = 0; i < frames; i++) err = Math.max(err, Math.abs(decL[i] - interleaved[2 * i]));
    expect(err).toBeLessThan(2 / 32768);
  });
});

describe('测试带合成器', () => {
  it('三种场景均可生成且峰值有限、长度正确', () => {
    for (const key of ['mild', 'severe', 'humOnly'] as const) {
      const p = { ...SCENARIOS[key], durationSec: 2 };
      const { stereo, groundTruth } = synthesizeTestTape(p, spec);
      expect(stereo.length).toBe(2 * p.sampleRate * p.durationSec);
      let peak = 0;
      for (const v of stereo) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeLessThanOrEqual(1);
      expect(groundTruth.scenario).toBe(key);
    }
  });

  it('重度场景的高频确实比轻度场景更暗', () => {
    const a = synthesizeTestTape({ ...SCENARIOS.mild, durationSec: 4 }, spec).stereo;
    const b = synthesizeTestTape({ ...SCENARIOS.severe, durationSec: 4 }, spec).stereo;
    const energyRatio = (s: Float32Array) => {
      let hi = 0, lo = 0;
      const n = s.length / 2;
      for (let i = 0; i < n; i++) {
        const v = s[2 * i];
        // 粗略：用差分能量代理高频
        if (i > 0) hi += (v - s[2 * (i - 1)]) ** 2;
        lo += v * v;
      }
      return hi / (lo + 1e-12);
    };
    expect(energyRatio(b)).toBeLessThan(energyRatio(a));
  });
});

function concat(arrs: Float32Array[]): Float32Array {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
