/**
 * 变采样率重采样：抖晃校正的核心。
 *
 * 磁带走速不稳等价于播放速率 r(t) 在 1 附近波动。校正时按测得的速率
 * 曲线反向寻址（相位累加器 + 三次 Catmull-Rom 插值），把每个输出样本
 * 映射回输入时间轴。
 */

/** Catmull-Rom 三次插值，x∈[0,1)，p0..p3 为相邻四点。 */
export function cubicInterpolate(p0: number, p1: number, p2: number, p3: number, x: number): number {
  const x2 = x * x;
  const x3 = x2 * x;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * x +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * x2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * x3)
  );
}

function sampleAt(input: ArrayLike<number>, pos: number): number {
  const n = input.length;
  const i = Math.floor(pos);
  const frac = pos - i;
  // 全部索引钳制到 [0, n-1]，越界时保持边界样本
  const i0 = Math.min(n - 1, Math.max(0, i - 1));
  const i1 = Math.min(n - 1, Math.max(0, i));
  const i2 = Math.min(n - 1, Math.max(0, i + 1));
  const i3 = Math.min(n - 1, Math.max(0, i + 2));
  return cubicInterpolate(input[i0], input[i1], input[i2], input[i3], frac);
}

export interface RateMap {
  /** 每秒一个控制点的播放速率（相对额定带速，1 = 正常）。 */
  ratesPerSecond: Float64Array;
  sampleRate: number;
}

/** 线性插值取任意秒处的速率。 */
export function sampleRateMap(map: RateMap, tSeconds: number): number {
  const a = map.ratesPerSecond;
  const x = tSeconds;
  const i = Math.floor(x);
  if (i <= 0) return a[0];
  if (i >= a.length - 1) return a[a.length - 1];
  const frac = x - i;
  return a[i] * (1 - frac) + a[i + 1] * frac;
}

/**
 * 用速率图校正单通道。
 *
 * 相位累加：输出样本 m 对应输入位置 φ(m)，每个输出样本推进
 *     Δφ = r(t)  （播放快了就多跳过输入样本，把时间轴拉直）
 * 输出长度与输入一致（末端不足部分钳制），保证左右声道与 A/B 对齐。
 */
export function resampleChannel(input: Float64Array | Float32Array, map: RateMap): Float64Array {
  const out = new Float64Array(input.length);
  const fs = map.sampleRate;
  let phase = 0;
  for (let m = 0; m < out.length; m++) {
    out[m] = sampleAt(input, phase);
    const t = m / fs;
    phase += sampleRateMap(map, t);
  }
  return out;
}

/** 直接按“每输入样本一个速率”的稠密数组重采样（测试与 Worklet 校验用）。 */
export function resampleChannelDense(input: Float64Array | Float32Array, rates: ArrayLike<number>): Float64Array {
  const out = new Float64Array(input.length);
  let phase = 0;
  for (let m = 0; m < out.length; m++) {
    out[m] = sampleAt(input, phase);
    phase += rates[Math.min(m, rates.length - 1)];
  }
  return out;
}
