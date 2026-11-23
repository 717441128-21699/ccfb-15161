/**
 * 迭代 radix-2 FFT（基 2，输入长度必须为 2 的幂）。
 * 原地运算；输入输出为交错的实部/虚部数组（长度 2N）。
 * 同时供 TS 参考实现与单元测试使用，Worklet 内保留一份等价移植。
 */

export function fftInPlace(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT 长度必须为 2 的幂');
  if (im.length !== n) throw new Error('实部虚部数组长度不一致');

  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? -1 : 1);
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tr = curR * re[b] - curI * im[b];
        const ti = curR * im[b] + curI * re[b];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nr;
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

/** Hann 窗（周期性，peroidic），长度 n。 */
export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * 对一段实信号做加窗 FFT，返回幅度谱（长度 n/2+1）。
 * 复用调用方缓冲区以减少 GC（长音频处理关键路径）。
 */
export function magnitudeSpectrum(
  frame: Float64Array | Float32Array,
  window: Float64Array,
  re: Float64Array,
  im: Float64Array,
): Float64Array {
  const n = frame.length;
  for (let i = 0; i < n; i++) {
    re[i] = frame[i] * window[i];
    im[i] = 0;
  }
  fftInPlace(re, im);
  const half = n >> 1;
  const mag = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) mag[k] = Math.hypot(re[k], im[k]);
  return mag;
}
