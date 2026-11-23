/**
 * 修复滤波器设计（两级级联，均为线性相位 FIR）：
 *
 *   H_corr = H_gap(f) · z^-D           零相位高频补偿 + 固定群延迟 D
 *   H_align(n) = sinc(n - D - d_c)      分数延迟对齐，总延迟 D + d_c
 *
 * 关键约束：因果 FIR 的物理延迟必须落在抽头窗口 [0, M-1] 内。
 * 把“高频提升（零相位）”和“声道对齐（非负延迟）”拆成两个滤波器后，
 * 两者的群延迟都在合法区间，避免了单滤波器频率采样绕卷导致的伪响应。
 *
 * 对齐约定：估计得到右声道比左声道晚 d 个样本，则把左声道延后 d，
 * 两条声道最终对齐到较晚的时间轴。
 */

import { fftInPlace } from './fft';
import { gapLossLinear, gapWidthFromLossAt10k, TAPE_SPEED_MPS, linearToDb } from './constants';

export interface GapFilter {
  /** 零相位高频补偿 FIR（因果实现，群延迟 = D）。 */
  taps: Float64Array;
  /** 群延迟（样本）。 */
  groupDelay: number;
}

export interface DelayFilter {
  /** 分数延迟 FIR（窗 sinc）。 */
  taps: Float64Array;
  /** 实际延迟（样本，含整数部分与 D 基准）。 */
  delaySamples: number;
  groupDelay: number;
}

export interface ChannelPlan {
  gap: GapFilter;
  align: DelayFilter;
  /** 两级合并后的等效抽头（供只支持单级卷积的路径使用）。 */
  combined: Float64Array;
}

export interface StereoFilterPlan {
  left: ChannelPlan;
  right: ChannelPlan;
  /** 两条声道共同的总群延迟（样本）。 */
  groupDelaySamples: number;
  /** 设计目标在 10kHz 的响应（线性，相对 1kHz）。 */
  responseAt10k: number;
}

export interface FilterOptions {
  /** 抽头数（奇数），默认 97。 */
  taps?: number;
  /** 逆滤波最大提升量（dB）。 */
  maxBoostDb?: number;
}

/** 设计零相位缝隙损耗逆滤波器（对称 FIR，群延迟 D=(M-1)/2）。 */
export function designGapInverseFilter(
  gapM: number,
  sampleRate: number,
  opts: FilterOptions = {},
): GapFilter {
  const M = opts.taps ?? 97;
  if (M % 2 === 0) throw new Error('抽头数必须为奇数');
  const D = (M - 1) / 2;
  const maxBoost = Math.pow(10, (opts.maxBoostDb ?? 12) / 20);
  const nfft = 2048;

  // 目标：实值、偶对称的幅度谱（零相位）
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let k = 0; k < nfft; k++) {
    // 负频率折叠
    const fk = k <= nfft / 2 ? k : k - nfft;
    const f = Math.abs((fk * sampleRate) / nfft);
    const loss = gapLossLinear(f, gapM, TAPE_SPEED_MPS);
    let mag = 1 / Math.max(loss, 1e-4);
    mag = Math.min(mag, maxBoost);
    if (f > sampleRate * 0.42) {
      const fade = Math.max(0, (sampleRate / 2 - f) / (sampleRate * 0.08));
      mag = 1 + (mag - 1) * fade;
    }
    re[k] = mag;
    im[k] = 0;
  }
  fftInPlace(re, im, true);

  // 零相位脉冲响应关于 0 对称；移位 D 得到因果 FIR
  const taps = new Float64Array(M);
  for (let n = 0; n < M; n++) {
    let idx = (n - D + nfft) % nfft;
    if (idx < 0) idx += nfft;
    taps[n] = re[idx];
  }
  // Hann 窗截断
  for (let n = 0; n < M; n++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (M - 1));
    taps[n] *= w;
  }
  return { taps, groupDelay: D };
}

/**
 * 设计分数延迟滤波器（窗 sinc 法），总延迟 = D + frac（D 为整数基准）。
 * frac ∈ [0, 1)。
 */
export function designFractionalDelay(
  delayFraction: number,
  sampleRate: number,
  opts: FilterOptions = {},
): DelayFilter {
  void sampleRate;
  const M = opts.taps ?? 97;
  if (M % 2 === 0) throw new Error('抽头数必须为奇数');
  const D = (M - 1) / 2;
  const center = D + delayFraction; // sinc 峰值位置
  const taps = new Float64Array(M);
  const half = M / 2;
  for (let n = 0; n < M; n++) {
    const x = n - center;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / half); // Hann 截断
    taps[n] = sinc * w;
  }
  return { taps, delaySamples: center, groupDelay: D };
}

/** 线性卷积合并两个 FIR（长度 M1+M2-1），再截回共同长度 M。 */
function combineFilters(a: Float64Array, b: Float64Array, M: number): Float64Array {
  const full = new Float64Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) full[i + j] += a[i] * b[j];
  }
  // 两者群延迟之和的中心对齐截回 M
  const center = (full.length - 1) / 2;
  const start = Math.round(center - (M - 1) / 2);
  const out = new Float64Array(M);
  for (let n = 0; n < M; n++) {
    const idx = start + n;
    if (idx >= 0 && idx < full.length) out[n] = full[idx];
  }
  return out;
}

/** 评估 FIR 在指定频率的幅度响应（线性）。 */
export function evaluateMagnitude(taps: ArrayLike<number>, freqHz: number, sampleRate: number): number {
  let re = 0;
  let im = 0;
  const w = 2 * Math.PI * (freqHz / sampleRate);
  for (let i = 0; i < taps.length; i++) {
    re += taps[i] * Math.cos(w * i);
    im -= taps[i] * Math.sin(w * i);
  }
  return Math.hypot(re, im);
}

/**
 * 根据方位角延迟与高频损耗生成左右声道滤波器对。
 *
 * @param delaySeconds 右声道相对左声道延迟（正=右晚）
 * @param lossDbAt10k  观测到的 10kHz 衰减（dB，正数）
 */
export function designStereoPlan(
  delaySeconds: number,
  lossDbAt10k: number,
  sampleRate: number,
  taps = 97,
): StereoFilterPlan {
  const gapM = gapWidthFromLossAt10k(Math.max(0.1, lossDbAt10k));
  const opts: FilterOptions = { taps, maxBoostDb: 12 };
  const gap = designGapInverseFilter(gapM, sampleRate, opts);

  // 右晚 d 样本 → 左声道延后 d；右声道仅群延迟对齐（d_right = 0）
  const dSamples = Math.max(0, delaySeconds * sampleRate);

  const buildChannel = (extraDelay: number): ChannelPlan => {
    const align = designFractionalDelay(extraDelay % 1, sampleRate, opts);
    // 整数部分通过把 sinc 中心再平移整数实现：直接以总分数中心重设计
    const totalDelay = extraDelay;
    const alignShifted = shiftDelay(align, Math.floor(totalDelay), taps);
    const combined = combineFilters(gap.taps, alignShifted.taps, taps);
    return { gap, align: alignShifted, combined };
  };

  const left = buildChannel(dSamples);
  const right = buildChannel(0);

  const mag10k = evaluateMagnitude(left.combined, 10000, sampleRate);
  const mag1k = evaluateMagnitude(left.combined, 1000, sampleRate);
  return {
    left,
    right,
    groupDelaySamples: (taps - 1) / 2 + dSamples,
    responseAt10k: mag10k / mag1k,
  };
}

/** 在分数延迟基础上再平移整数样本（sinc 中心 = D + int + frac）。 */
function shiftDelay(base: DelayFilter, intShift: number, M: number): DelayFilter {
  if (intShift === 0) return base;
  const D = (M - 1) / 2;
  const frac = base.delaySamples - D;
  const center = D + intShift + frac;
  const taps = new Float64Array(M);
  const half = M / 2;
  for (let n = 0; n < M; n++) {
    const x = n - center;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / half);
    taps[n] = sinc * w;
  }
  return { taps, delaySamples: center, groupDelay: D };
}

/** 设计响应的 10kHz 形状偏差（dB，相对 1kHz）。 */
export function designedResidualDb(plan: StereoFilterPlan, sampleRate: number): number {
  const m10 = evaluateMagnitude(plan.left.combined, 10000, sampleRate);
  const m1 = evaluateMagnitude(plan.left.combined, 1000, sampleRate);
  return linearToDb(m10 / m1);
}
