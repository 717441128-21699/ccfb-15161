import { FFT, hannWindow, magnitudeSpectrum } from './fft';

export interface DetectedTone {
  frequency: number;
  /** 峰附近谱能量占总能量的比例 0..1 */
  purity: number;
  level: number;
  kind: 'reference' | 'hum';
}

/**
 * 在录音开头（或任意片段）中寻找参考音；找不到则搜索 50/60Hz 交流哼声。
 * 多帧平均幅度谱后做局部峰搜索，给出频率与纯度。
 */
export function detectReferenceOrHum(
  signal: ArrayLike<number>,
  sampleRate: number,
  preferredRefHz = 1000,
): DetectedTone | null {
  const n = Math.min(8192, signal.length);
  if (n < 2048) return null;
  const fftSize = n;
  const fft = new FFT(fftSize);
  const win = hannWindow(fftSize);
  const hop = fftSize / 2;
  const frames = Math.max(1, Math.floor((signal.length - fftSize) / hop) + 1);
  const acc = new Float64Array(fftSize / 2 + 1);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    const frame = Array.from({ length: fftSize }, (_, i) => signal[off + i] ?? 0);
    const mag = magnitudeSpectrum(fft, frame, win);
    for (let k = 0; k < acc.length; k++) acc[k] += mag[k];
  }
  for (let k = 0; k < acc.length; k++) acc[k] /= frames;

  const binHz = sampleRate / fftSize;
  const totalEnergy = acc.reduce((s, v) => s + v * v, 0);

  // 1) 优先在登记的参考音附近找峰（±3%，覆盖抖晃导致的频率漂移）
  const ref = findPeakNear(acc, preferredRefHz / binHz, 0.03);
  if (ref) {
    const purity = purityOf(acc, ref);
    // 参考音即使被节目声掩盖，只要局部谱线可辨即可用（DFT 锁相会再提纯）
    if (purity > 0.08) return tone(acc, ref, binHz, totalEnergy, 'reference');
  }
  // 2) 行业常见参考音频率
  for (const cand of [3150, 3000, 1000, 440]) {
    const pk = findPeakNear(acc, cand / binHz, 0.02);
    if (pk && purityOf(acc, pk) > 0.08) return tone(acc, pk, binHz, totalEnergy, 'reference');
  }
  // 3) 退回交流哼声（50/60Hz，含谐波能量合并判断）
  for (const hum of [50, 60]) {
    const pk = findPeakNear(acc, hum / binHz, 0.05);
    if (!pk) continue;
    const d = tone(acc, pk, binHz, totalEnergy, 'hum');
    if (d.level > 0.002) return d;
  }
  return null;
}

function findPeakNear(mag: Float64Array, bin: number, relTol: number): number | null {
  const center = Math.round(bin);
  const tol = Math.max(2, Math.round(bin * relTol));
  let best = -1, bestV = -1;
  for (let k = Math.max(1, center - tol); k <= Math.min(mag.length - 2, center + tol); k++) {
    if (mag[k] > bestV && mag[k] >= mag[k - 1] && mag[k] >= mag[k + 1]) {
      bestV = mag[k]; best = k;
    }
  }
  return best < 0 ? null : best;
}

/** 峰 ±3 bin 能量占比 */
function purityOf(mag: Float64Array, peak: number): number {
  let peakE = 0, allE = 1e-12;
  for (let k = 1; k < mag.length; k++) {
    const e = mag[k] * mag[k];
    allE += e;
    if (Math.abs(k - peak) <= 3) peakE += e;
  }
  return peakE / allE;
}

function tone(mag: Float64Array, peak: number, binHz: number, totalEnergy: number, kind: DetectedTone['kind']): DetectedTone {
  // 抛物线插值得到亚 bin 频率
  const a = mag[peak - 1] ?? 0, b = mag[peak], c = mag[peak + 1] ?? 0;
  const shift = (0.5 * (a - c)) / (a - 2 * b + c + 1e-12);
  const frequency = (peak + shift) * binHz;
  let peakE = 0;
  for (let k = Math.max(1, peak - 3); k <= Math.min(mag.length - 1, peak + 3); k++) peakE += mag[k] * mag[k];
  return {
    frequency,
    purity: peakE / (totalEnergy + 1e-12),
    level: b,
    kind,
  };
}
