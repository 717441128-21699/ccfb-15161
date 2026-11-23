/**
 * 磁头方位角估计：时域粗-精两级，由声道延迟反演方位角。
 *
 * 模型：右声道相对左声道延迟 τ（秒），即 R[n] ≈ L[n-τ]。
 *   1) 粗级：加窗归一化互相关，定位整数样本延迟；
 *   2) 精级：固定整数延迟，对分数部分做网格 + 抛物线插值的最小 MSE 拟合
 *      （L 侧三次 Catmull-Rom 插值），亚样本精度稳定；
 *   3) 多帧加权平均 → τ → 方位角（角分）。
 *
 * 选时域而非互谱相位斜率：本应用的节目素材带强谐波，包裹相位在高频
 * 易跳变；时域 MSE 在 2–8kHz 宽带相关信号上偏差可稳定低于 0.05 样本
 * （约 0.5 角分），满足 2 角分指标。
 */

import { hannWindow } from './fft';
import { RAD_TO_ARCMIN, delaySecondsToAzimuth } from './constants';
import { cubicInterpolate } from './resample';

export interface AzimuthEstimate {
  thetaRad: number;
  thetaArcmin: number;
  /** 右声道相对左声道的延迟，秒（正=右晚）。 */
  delaySeconds: number;
  /** 跨帧延迟标准差，秒（稳定性指标）。 */
  delayStdSeconds: number;
  /** 归一化拟合残差（RMS / 信号 RMS），越小越可信。 */
  residualRms: number;
  binsUsed: number;
  /** 粗互相关峰值（归一化，0..1）。 */
  coherence: number;
}

export interface AzimuthConfig {
  sampleRate: number;
  fftSize?: number; // 复用为帧长
  minFreqHz?: number; // 兼容旧配置，时域路径不使用
  maxFreqHz?: number;
  maxFrames?: number;
  /** 粗搜索最大延迟（样本），默认 64（约覆盖 ±67 角分）。 */
  maxLagSamples?: number;
}

interface FrameResult {
  tau: number; // 秒
  residual: number;
  coherence: number;
}

function sampleL(left: ArrayLike<number>, base: number, pos: number): number {
  const i = Math.floor(pos);
  const frac = pos - i;
  const i0 = Math.max(0, base + i - 1);
  const i1 = Math.max(0, base + i);
  const i2 = Math.min(left.length - 1, base + i + 1);
  const i3 = Math.min(left.length - 1, base + i + 2);
  return cubicInterpolate(left[i0], left[i1], left[i2], left[i3], frac);
}

/** 单帧：粗互相关 + 分数 MSE 精修。 */
function estimateFrame(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  start: number,
  n: number,
  maxLag: number,
  window: Float64Array,
): FrameResult | null {
  // --- 粗级：整数延迟互相关 ---
  let eL = 0;
  let eR = 0;
  for (let i = 0; i < n; i++) {
    eL += left[start + i] * left[start + i] * window[i] * window[i];
    eR += right[start + i] * right[start + i] * window[i] * window[i];
  }
  const norm = Math.sqrt(eL * eR) + 1e-12;
  let bestLag = 0;
  let bestCorr = -Infinity;
  const corrAt = (lag: number): number => {
    let acc = 0;
    if (lag >= 0) {
      for (let i = lag; i < n; i++) {
        acc += left[start + i - lag] * right[start + i] * window[i] * window[i];
      }
    } else {
      for (let i = 0; i < n + lag; i++) {
        acc += left[start + i - lag] * right[start + i] * window[i] * window[i];
      }
    }
    return acc / norm;
  };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const v = corrAt(lag);
    if (v > bestCorr) {
      bestCorr = v;
      bestLag = lag;
    }
  }
  if (bestCorr < 0.1) return null; // 相关性太弱，本帧不可信

  // --- 精修：在 [bestLag-1, bestLag+1] 上以 0.02 步长扫分数 MSE ---
  // 只在帧中部拟合，避开插值边界
  const fitStart = 32;
  const fitEnd = n - 32;
  const evaluate = (tau: number): number => {
    let se = 0;
    let sw = 0;
    for (let i = fitStart; i < fitEnd; i++) {
      const pred = sampleL(left, start, i - tau);
      const e = right[start + i] - pred;
      const w = window[i] * window[i];
      se += w * e * e;
      sw += w;
    }
    return se / sw;
  };

  let bestTau = bestLag;
  let bestMse = evaluate(bestLag);
  const step = 0.02;
  for (let s = -50; s <= 50; s++) {
    const tau = bestLag + s * step;
    const mse = evaluate(tau);
    if (mse < bestMse) {
      bestMse = mse;
      bestTau = tau;
    }
  }
  // 抛物线亚网格插值（用相邻三点）
  const y0 = evaluate(bestTau - step);
  const y1 = bestMse;
  const y2 = evaluate(bestTau + step);
  const denom = y0 - 2 * y1 + y2;
  if (Math.abs(denom) > 1e-15) {
    const offset = (0.5 * (y0 - y2)) / denom;
    if (Math.abs(offset) <= 1) bestTau += offset * step;
  }

  // 归一化残差：MSE 开根 / R 帧 RMS
  const residual = Math.sqrt(bestMse) / (Math.sqrt(eR / n) + 1e-12);
  return { tau: bestTau, residual, coherence: bestCorr };
}

export function estimateAzimuth(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  cfg: AzimuthConfig,
): AzimuthEstimate {
  const fs = cfg.sampleRate;
  const n = cfg.fftSize ?? 2048;
  const hop = n >> 2;
  const maxFrames = cfg.maxFrames ?? 48;
  const maxLag = cfg.maxLagSamples ?? 64;
  const window = hannWindow(n);
  const frames: FrameResult[] = [];

  for (let start = 0; start + n <= left.length && frames.length < maxFrames; start += hop) {
    const fr = estimateFrame(left, right, start, n, maxLag, window);
    if (fr) frames.push({ ...fr, tau: fr.tau / fs });
  }

  if (frames.length === 0) {
    return {
      thetaRad: 0, thetaArcmin: 0, delaySeconds: 0, delayStdSeconds: 0,
      residualRms: Infinity, binsUsed: 0, coherence: 0,
    };
  }

  // 帧间按 1/(残差+0.05) 加权
  let wsum = 0, tausum = 0, tausq = 0, resSum = 0, cohSum = 0;
  for (const fr of frames) {
    const w = 1 / (fr.residual + 0.05);
    wsum += w;
    tausum += w * fr.tau;
    tausq += w * fr.tau * fr.tau;
    resSum += fr.residual;
    cohSum += fr.coherence;
  }
  const tau = tausum / wsum;
  const tauStd = Math.sqrt(Math.max(0, tausq / wsum - tau * tau));
  const theta = delaySecondsToAzimuth(tau);

  return {
    thetaRad: theta,
    thetaArcmin: theta * RAD_TO_ARCMIN,
    delaySeconds: tau,
    delayStdSeconds: tauStd,
    residualRms: resSum / frames.length,
    binsUsed: frames.length * n,
    coherence: cohSum / frames.length,
  };
}
