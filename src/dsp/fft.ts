/**
 * 迭代 radix-2 FFT（原地）+ 常用频谱工具。
 * 仅依赖 TypedArray，可同时运行于主线程、Node 与 AudioWorklet。
 */
export class FFT {
  readonly n: number;
  private readonly rev: Int32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

  constructor(n: number) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error('FFT 长度必须是 2 的幂');
    this.n = n;
    this.rev = new Int32Array(n);
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      this.rev[i] = j;
    }
    this.cos = new Float64Array(n >> 1);
    this.sin = new Float64Array(n >> 1);
    for (let k = 0; k < n >> 1; k++) {
      // 标准 DFT 约定：正变换旋转因子 e^{−j2πk/n}
      this.cos[k] = Math.cos((2 * Math.PI * k) / n);
      this.sin[k] = Math.sin((2 * Math.PI * k) / n);
    }
  }

  /** 原地复 FFT：re/im 长度均为 n */
  run(re: Float64Array | Float32Array, im: Float64Array | Float32Array, inverse = false): void {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        let k = 0;
        for (let j = i; j < i + half; j++, k += step) {
          const wr = cos[k];
          // 正变换 e^{−jθ}（wi 取负），逆变换 e^{+jθ}（wi 取正）
          const wi = inverse ? sin[k] : -sin[k];
          const aR = re[j + half], aI = im[j + half];
          const tR = aR * wr - aI * wi;
          const tI = aR * wi + aI * wr;
          re[j + half] = re[j] - tR;
          im[j + half] = im[j] - tI;
          re[j] += tR;
          im[j] += tI;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] /= n;
        im[i] /= n;
      }
    }
  }
}

/** Hann 窗（周期性，适合频谱分析） */
export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** 估计实信号幅度谱（线性峰值幅度），输出长度 n/2+1 */
export function magnitudeSpectrum(fft: FFT, signal: ArrayLike<number>, window?: ArrayLike<number>): Float64Array {
  const n = fft.n;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let winSum = 0;
  for (let i = 0; i < n; i++) {
    const w = window ? window[i] : 1;
    winSum += w;
    re[i] = signal[i] * w;
  }
  fft.run(re, im);
  // 加窗后按窗系数和归一化，使单频正弦峰值幅度 ≈ 信号振幅
  const out = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) out[k] = (Math.hypot(re[k], im[k]) * 2) / winSum;
  return out;
}

/** 复数互相关（频域），返回圆互相关实序列 */
export function crossCorrelation(fft: FFT, a: ArrayLike<number>, b: ArrayLike<number>, window: ArrayLike<number>): Float64Array {
  const n = fft.n;
  const ar = new Float64Array(n), ai = new Float64Array(n);
  const br = new Float64Array(n), bi = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    ar[i] = a[i] * window[i];
    br[i] = b[i] * window[i];
  }
  fft.run(ar, ai);
  fft.run(br, bi);
  // C = A * conj(B)
  const cr = new Float64Array(n), ci = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    cr[k] = ar[k] * br[k] + ai[k] * bi[k];
    ci[k] = ai[k] * br[k] - ar[k] * bi[k];
  }
  fft.run(cr, ci, true);
  return cr;
}
