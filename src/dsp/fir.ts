/**
 * FIR 卷积的 TypeScript 参考实现（Overlap-Save，频域分段）。
 * AudioWorklet 内有时域直接卷积版本；两者用同一组系数，
 * 测试会交叉验证输出一致。
 */

/** 时域直接卷积（短滤波器用，Worklet 端的对应实现）。 */
export function convolveDirect(input: ArrayLike<number>, taps: ArrayLike<number>): Float64Array {
  const out = new Float64Array(input.length);
  const M = taps.length;
  for (let n = 0; n < input.length; n++) {
    let acc = 0;
    const k0 = Math.max(0, n - (input.length - 1));
    for (let k = k0; k < M; k++) {
      const idx = n - k;
      if (idx < 0) break;
      acc += taps[k] * input[idx];
    }
    out[n] = acc;
  }
  return out;
}

/** Overlap-Save 频域快速卷积（长信号路径）。 */
export function convolveOverlapSave(
  input: ArrayLike<number>,
  taps: ArrayLike<number>,
  fftImpl: {
    fft: (re: Float64Array, im: Float64Array, inverse?: boolean) => void;
  },
  blockSize = 4096,
): Float64Array {
  const M = taps.length;
  const fftSize = nextPow2(blockSize + M - 1);
  const hop = fftSize - M + 1;
  const out = new Float64Array(input.length);

  const hRe = new Float64Array(fftSize);
  const hIm = new Float64Array(fftSize);
  for (let i = 0; i < M; i++) hRe[i] = taps[i];
  fftImpl.fft(hRe, hIm);

  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  for (let start = -(M - 1); start < input.length; start += hop) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < fftSize; i++) {
      const idx = start + i;
      if (idx >= 0 && idx < input.length) re[i] = input[idx];
    }
    fftImpl.fft(re, im);
    for (let k = 0; k < fftSize; k++) {
      const rr = re[k] * hRe[k] - im[k] * hIm[k];
      const ii = re[k] * hIm[k] + im[k] * hRe[k];
      re[k] = rr;
      im[k] = ii;
    }
    fftImpl.fft(re, im, true);
    for (let i = M - 1; i < fftSize; i++) {
      const outIdx = start + i;
      if (outIdx >= 0 && outIdx < out.length) out[outIdx] = re[i];
    }
  }
  return out;
}

function nextPow2(x: number): number {
  let p = 1;
  while (p < x) p <<= 1;
  return p;
}

/**
 * 测量信号的幅度谱（平均周期图），返回频率轴与 dB 幅度。
 * 用于修复前后 10kHz 响应对比。
 */
export function measureResponse(
  signal: ArrayLike<number>,
  sampleRate: number,
  fftSize = 8192,
  fftImpl?: { fft: (re: Float64Array, im: Float64Array, inverse?: boolean) => void },
  maxFrames = 64,
): { freqs: Float64Array; magnitudeDb: Float64Array } {
  const fft = fftImpl?.fft ?? (() => { throw new Error('需要注入 FFT 实现'); });
  const hop = fftSize >> 1;
  const window = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / fftSize);
  const acc = new Float64Array(fftSize / 2 + 1);
  let frames = 0;

  // 长信号只取均匀分布的有限帧，周期图估计在 ~64 帧已收敛，
  // 处理耗时与磁带长度解耦；短信号（测试/探测段）保留全部帧以保证精度
  const totalFrames = Math.max(1, Math.floor((signal.length - fftSize) / hop) + 1);
  const useFrames = totalFrames <= maxFrames ? totalFrames : maxFrames;
  const frameStride = totalFrames / useFrames;

  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let fi = 0; fi < useFrames; fi++) {
    const start = Math.floor(fi * frameStride) * hop;
    for (let i = 0; i < fftSize; i++) {
      re[i] = signal[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= fftSize / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  const freqs = new Float64Array(fftSize / 2 + 1);
  const magnitudeDb = new Float64Array(fftSize / 2 + 1);
  for (let k = 0; k <= fftSize / 2; k++) {
    freqs[k] = (k * sampleRate) / fftSize;
    magnitudeDb[k] = 10 * Math.log10((acc[k] / Math.max(1, frames)) + 1e-12);
  }
  return { freqs, magnitudeDb };
}

/** 在响应曲线中插值取指定频率的 dB 值。 */
export function responseAtFreq(
  freqs: ArrayLike<number>,
  magnitudeDb: ArrayLike<number>,
  freqHz: number,
): number {
  if (freqHz <= freqs[0]) return magnitudeDb[0];
  for (let k = 1; k < freqs.length; k++) {
    if (freqs[k] >= freqHz) {
      const x0 = freqs[k - 1];
      const x1 = freqs[k];
      const frac = (freqHz - x0) / (x1 - x0);
      return magnitudeDb[k - 1] * (1 - frac) + magnitudeDb[k] * frac;
    }
  }
  return magnitudeDb[magnitudeDb.length - 1];
}
