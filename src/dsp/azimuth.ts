import { FFT, hannWindow } from './fft';
import { ARCMIN_PER_RAD, type AzimuthResult, type TapeSpec } from './types';

export interface AzimuthOptions {
  fftSize?: number;
  hop?: number;
  /** 只在该频带内估计方位（默认 1–12kHz，受高频损耗影响最小的中高频段） */
  bandHz?: [number, number];
  /** 相干度门限，低于此的帧丢弃 */
  coherenceGate?: number;
  /** 参与估计的最大帧数（控制长磁带处理成本） */
  maxFrames?: number;
}

/**
 * 磁头方位角估计。
 *
 * 物理模型：磁头缝相对磁带垂直方向偏 θ 时，两条立体磁迹上的同相分量
 * 出现到达时间差 τ = d·sinθ/v ≈ d·θ/v（d=磁迹间距，v=带速）。
 * τ 由左右声道 GCC-PHAT 粗定位 + 互谱相位斜率精修得到亚样本精度。
 */
export function estimateAzimuth(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  spec: TapeSpec,
  opts: AzimuthOptions = {},
): AzimuthResult {
  const fftSize = opts.fftSize ?? 4096;
  // 较大 hop 降低帧数：方位统计在 ~60 帧以上即稳定，无需 50% 重叠的密集采样
  const hop = opts.hop ?? fftSize;
  const [fLo, fHi] = opts.bandHz ?? [1000, 12000];
  const gate = opts.coherenceGate ?? 0.4;
  // 限制参与估计的最大帧数，控制长磁带的处理成本
  const maxFrames = opts.maxFrames ?? 120;

  const fft = new FFT(fftSize);
  const win = hannWindow(fftSize);
  const ar = new Float64Array(fftSize), ai = new Float64Array(fftSize);
  const br = new Float64Array(fftSize), bi = new Float64Array(fftSize);
  const binHz = spec.sampleRate / fftSize;
  const kLo = Math.max(1, Math.floor(fLo / binHz));
  const kHi = Math.min(fftSize / 2 - 1, Math.ceil(fHi / binHz));

  const estimates: { tau: number; coh: number }[] = [];
  const n = Math.min(left.length, right.length);

  let frameCount = 0;
  for (let off = 0; off + fftSize <= n && frameCount < maxFrames; off += hop) {
    frameCount++;
    // 显式清零，避免上一帧 FFT 频域结果残留（缓冲在帧间复用）
    ar.fill(0); ai.fill(0); br.fill(0); bi.fill(0);
    for (let i = 0; i < fftSize; i++) {
      ar[i] = left[off + i] * win[i];
      ai[i] = 0;
      br[i] = right[off + i] * win[i];
      bi[i] = 0;
    }
    fft.run(ar, ai);
    fft.run(br, bi);

    // 互谱 C = A·conj(B)，带内 PHAT 白化 + 幅度相干度（只取正频率段）
    let cohNum = 0, cohA = 0, cohB = 0;
    const cr = new Float64Array(fftSize), ci = new Float64Array(fftSize);
    for (let k = 0; k < fftSize; k++) {
      const inBand = k >= kLo && k <= kHi;
      const crossRe = ar[k] * br[k] + ai[k] * bi[k];
      const crossIm = ai[k] * br[k] - ar[k] * bi[k];
      if (inBand) {
        cohNum += Math.hypot(crossRe, crossIm);
        cohA += ar[k] * ar[k] + ai[k] * ai[k];
        cohB += br[k] * br[k] + bi[k] * bi[k];
      }
      const mag = Math.hypot(crossRe, crossIm);
      if (inBand && mag > 1e-12) {
        cr[k] = crossRe / mag;
        ci[k] = crossIm / mag;
      }
    }
    const denom = Math.sqrt(cohA * cohB);
    const rawCoh = denom > 1e-9 ? cohNum / denom : 0;
    const coherence = Number.isFinite(rawCoh) ? clamp01(rawCoh) : 0;
    if (coherence < gate) continue;

    const tau = estimateFrameDelay(ar, ai, br, bi, cr, ci, fft, fftSize, kLo, kHi, spec.sampleRate);
    estimates.push({ tau, coh: coherence });
  }

  if (estimates.length === 0) {
    return { delaySamples: 0, angleRad: 0, angleArcmin: 0, coherence: 0, perFrame: [] };
  }

  // 相干度加权中位数（对残余野点稳健）
  const sorted = [...estimates].sort((a, b) => a.tau - b.tau);
  const totalW = Math.max(1e-12, sorted.reduce((s, e) => s + e.coh, 0));
  let acc = 0, medianTau = sorted[0].tau;
  for (const e of sorted) {
    acc += e.coh;
    if (acc >= totalW / 2) { medianTau = e.tau; break; }
  }
  const angleRad = delayToAngle(medianTau, spec);
  const meanCoh = Number.isFinite(totalW) ? clamp01(totalW / estimates.length) : 0;
  return {
    delaySamples: medianTau,
    angleRad,
    angleArcmin: angleRad * ARCMIN_PER_RAD,
    coherence: meanCoh,
    perFrame: estimates.map(e => e.tau),
  };
}

/**
 * 单帧亚样本延迟估计（两阶段，无符号歧义）。
 *
 * 阶段一：GCC-PHAT 圆相关峰给出粗整数延迟 coarseD。
 * 阶段二：把 coarseD 的理论相位从互谱中扣除，残差相位在每个频点独立
 *   落在 ±π（分数延迟 |δ|<0.5 样本保证），无需跨 bin 解缠绕；
 *   对残差做加权线性回归，斜率直接给带符号分数 δ，最终 d = coarseD + δ。
 *
 * 输出约定：右声道相对左声道延迟 d 个样本时返回 +d。
 */
function estimateFrameDelay(
  ar: Float64Array, ai: Float64Array,
  br: Float64Array, bi: Float64Array,
  cr: Float64Array, ci: Float64Array,
  fft: FFT, fftSize: number, kLo: number, kHi: number, sampleRate: number,
): number {
  // 阶段一：PHAT 粗峰 → 粗整数延迟
  fft.run(cr, ci, true);
  const maxLag = Math.min(fftSize / 4, Math.floor(fftSize / 2));
  let peakIdx = 0, bestV = cr[0];
  for (let idx = 1; idx <= maxLag; idx++) {
    if (cr[idx] > bestV) { bestV = cr[idx]; peakIdx = idx; }
    const negIdx = fftSize - idx;
    if (cr[negIdx] > bestV) { bestV = cr[negIdx]; peakIdx = negIdx; }
  }
  const circularPeak = peakIdx > fftSize / 2 ? peakIdx - fftSize : peakIdx;
  const coarseD = -circularPeak; // A·conj(B) 峰在 −d

  // 阶段二：全带互谱相位逐 bin 解缠绕，加权回归得连续延迟，粗峰吸附整数分支。
  const pts: Array<{ f: number; ph: number; w: number }> = [];
  let prevPhase: number | null = null;
  let unwrap = 0;
  for (let k = kLo; k <= kHi; k++) {
    const re = ar[k] * br[k] + ai[k] * bi[k];
    const im = ai[k] * br[k] - ar[k] * bi[k];
    const w = Math.hypot(re, im);
    if (w < 1e-12) continue;
    let ph = Math.atan2(im, re);
    if (prevPhase !== null) {
      while (ph + unwrap - prevPhase > Math.PI) unwrap -= 2 * Math.PI;
      while (ph + unwrap - prevPhase < -Math.PI) unwrap += 2 * Math.PI;
    }
    prevPhase = ph + unwrap;
    pts.push({ f: (k * sampleRate) / fftSize, ph: prevPhase, w });
  }
  if (pts.length < 4) return coarseD;

  const { slope } = weightedLinearFit(pts);
  if (!Number.isFinite(slope)) return coarseD;
  // 全带解缠绕相位斜率给连续延迟，粗峰吸附整周期分支
  const dSlope = (slope * sampleRate) / (2 * Math.PI);
  return dSlope + Math.round(coarseD - dSlope);
}

/** 加权带截距一元线性回归，返回斜率与截距 */
function weightedLinearFit(pts: Array<{ f: number; ph: number; w: number }>): {
  slope: number;
  intercept: number;
} {
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const q of pts) {
    sw += q.w;
    sx += q.w * q.f;
    sy += q.w * q.ph;
    sxx += q.w * q.f * q.f;
    sxy += q.w * q.f * q.ph;
  }
  const denom = sw * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return { slope: 0, intercept: 0 };
  const slope = (sw * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / sw;
  return { slope, intercept };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** τ（样本）→ 方位角（弧度）：θ = asin(τ · fs⁻¹ · v / d) */
export function delayToAngle(delaySamples: number, spec: TapeSpec): number {
  const tauSec = delaySamples / spec.sampleRate;
  const sinTheta = (tauSec * spec.tapeSpeed) / spec.trackSpacingM;
  return Math.asin(Math.max(-1, Math.min(1, sinTheta)));
}

/** 方位角（弧度）→ 需要补偿的分数延迟（样本） */
export function angleToDelay(angleRad: number, spec: TapeSpec): number {
  const tauSec = (spec.trackSpacingM * Math.sin(angleRad)) / spec.tapeSpeed;
  return tauSec * spec.sampleRate;
}
