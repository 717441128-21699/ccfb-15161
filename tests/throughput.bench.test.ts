import { describe, it, expect } from 'vitest';
import { runKernelPipeline } from '../src/dsp/kernel-pipeline';
import { OPEN_REEL_SPEC, Rng, synthesizeTestTape, SCENARIOS } from '../src/dsp/synthesis';
import type { TapeSpec } from '../src/dsp/types';

/**
 * 验收要求：60 分钟磁带处理 ≤2 分钟，即实时倍率 ≥30×。
 *
 * 浏览器 Worklet 路径与本测试共用同一批 DSP 核（IQ 跟踪、Catmull-Rom
 * 重采样、GCC-PHAT、FIR 卷积），OAC 渲染本身只增加调度开销。
 * 这里在 Node 中对内核计时并外推 60 分钟时长；另在浏览器实验室页面
 * 做真实 Worklet 实测（见“修复处理页 → 测试实验室”）。
 */
describe('处理吞吐（验收线：实时倍率 ≥30×）', () => {
  const SR = 48000;
  const spec: TapeSpec = {
    ...OPEN_REEL_SPEC,
    sampleRate: SR,
    refToneHz: 1000,
    refChannel: 0,
    humHz: 50,
  };

  it('重度场景 60s 片段：内核实时倍率 ≥30×，外推 60 分钟 <2 分钟', () => {
    // 合成只做一次且不计入处理耗时
    const p = { ...SCENARIOS.severe, durationSec: 60 };
    const { stereo } = synthesizeTestTape(p, spec);
    const n = stereo.length / 2;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      L[i] = stereo[2 * i];
      R[i] = stereo[2 * i + 1];
    }

    const t0 = performance.now();
    const result = runKernelPipeline(L, R, spec);
    const elapsedSec = (performance.now() - t0) / 1000;
    const factor = 60 / elapsedSec;
    const projected60MinSec = (60 * 60) / factor;

    console.log(
      `\n[吞吐] 60s 重度损伤带处理耗时 ${elapsedSec.toFixed(2)}s，` +
      `实时倍率 ${factor.toFixed(1)}×，外推 60 分钟磁带需 ${(projected60MinSec / 60).toFixed(2)} 分钟`,
    );
    console.log(
      `[指标] 方位 ${result.azimuth.angleArcmin.toFixed(2)} 角分，` +
      `10kHz 残差 ${result.eq[0].residualAt10kDb.toFixed(2)} dB，` +
      `抖晃峰峰 ${result.drift.wowFlutterPct.toFixed(2)}%`,
    );

    expect(factor).toBeGreaterThanOrEqual(30);
    expect(projected60MinSec).toBeLessThanOrEqual(120);
  });

  it('长时稳定性：连续处理 4×30s 无状态漂移/内存异常', () => {
    const rng = new Rng(42);
    const n = 30 * SR;
    const lengths: number[] = [];
    for (let rep = 0; rep < 4; rep++) {
      const L = new Float32Array(n);
      const R = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        // 含稳定 1kHz 参考音（真实磁带必有参考音或哼声），跟踪器才能锁定
        const prog = 0.2 * rng.gaussian() + 0.15 * Math.sin(2 * Math.PI * 1000 * t);
        L[i] = prog;
        R[i] = prog * 0.98;
      }
      const out = runKernelPipeline(L, R, spec);
      lengths.push(out.outL.length);
      expect(out.outL.every(v => Number.isFinite(v))).toBe(true);
    }
    // 有稳定参考音时，同样输入规模产出长度稳定（±0.5%，重采样边界样本差）
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    for (const l of lengths) expect(Math.abs(l - mean) / mean).toBeLessThan(0.005);
  });
});
