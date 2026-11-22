import { FFT, hannWindow } from './fft';

/**
 * 磁头间隙损耗（Wallhead 公式）：
 *   H_gap(f) = |sin(π f λ / v) / (π f λ / v)|，λ = 有效缝长
 * 方位角偏差额外引入按 sinθ 摊薄的缝宽分量。
 */
export function gapLossResponse(freqs: ArrayLike<number>, _sampleRate: number, lambdaM: number, tapeSpeed: number): Float64Array {
  const out = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    const x = (Math.PI * freqs[i] * lambdaM) / tapeSpeed;
    out[i] = Math.abs(x < 1e-9 ? 1 : Math.sin(x) / x);
  }
  return out;
}

/** 用宽带噪声/音乐段测量通道平均幅度响应（线性峰值幅度，长度 n/2+1） */
export function measureResponse(signal: ArrayLike<number>, sampleRate: number, fftSize = 8192): {
  freqs: Float64Array;
  gain: Float64Array;
} {
  const fft = new FFT(fftSize);
  const win = hannWindow(fftSize);
  let winSum = 0;
  for (let i = 0; i < fftSize; i++) winSum += win[i];
  // 75% 重叠（hop=fftSize/4 改为 fftSize/2）：频响是平稳统计量，
  // 50% 重叠已足够，减半 FFT 帧数显著降低长信号测量成本。
  const hop = fftSize / 2;
  const acc = new Float64Array(fftSize / 2 + 1);
  let frames = 0;
  for (let off = 0; off + fftSize <= signal.length; off += hop) {
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i++) re[i] = signal[off + i] * win[i];
    fft.run(re, im);
    for (let k = 0; k <= fftSize / 2; k++) acc[k] += Math.hypot(re[k], im[k]);
    frames++;
  }
  if (frames === 0) frames = 1;
  const freqs = new Float64Array(fftSize / 2 + 1);
  for (let k = 0; k <= fftSize / 2; k++) {
    freqs[k] = (k * sampleRate) / fftSize;
    acc[k] = (acc[k] / frames) * (2 / winSum);
  }
  // 归一化到中低频基准（500–2000Hz 增益中位数 = 1），使结果反映频响的
  // 相对形状而非绝对电平。用中位数而非平均，避免参考音等窄带强线谱主导基准。
  const refLo = Math.max(1, Math.floor(500 / (sampleRate / fftSize)));
  const refHi = Math.max(refLo + 1, Math.ceil(2000 / (sampleRate / fftSize)));
  const refVals: number[] = [];
  for (let k = refLo; k <= refHi; k++) refVals.push(acc[k]);
  refVals.sort((a, b) => a - b);
  const refGain = refVals[Math.floor(refVals.length / 2)];
  if (refGain > 1e-12) {
    for (let k = 0; k <= fftSize / 2; k++) acc[k] /= refGain;
  }
  return { freqs, gain: acc };
}

/**
 * 立体声联合频响测量：对左右声道功率谱取几何平均，平滑方位角分数延迟
 * 造成的单通道梳状干涉谷，得到反映间隙损耗滚降的平滑频响，再归一化。
 * 两通道共用同一补偿目标（间隙损耗是磁头/磁带的共模特性）。
 */
export function measureStereoResponse(
  channels: ArrayLike<number>[],
  sampleRate: number,
  fftSize = 8192,
): { freqs: Float64Array; gain: Float64Array } {
  const fft = new FFT(fftSize);
  const win = hannWindow(fftSize);
  const hop = fftSize / 2;
  const logPower = new Float64Array(fftSize / 2 + 1);
  for (const signal of channels) {
    const power = new Float64Array(fftSize / 2 + 1);
    let frames = 0;
    for (let off = 0; off + fftSize <= signal.length; off += hop) {
      const re = new Float64Array(fftSize);
      const im = new Float64Array(fftSize);
      for (let i = 0; i < fftSize; i++) re[i] = signal[off + i] * win[i];
      fft.run(re, im);
      for (let k = 0; k <= fftSize / 2; k++) power[k] += Math.hypot(re[k], im[k]) ** 2;
      frames++;
    }
    for (let k = 0; k <= fftSize / 2; k++) {
      logPower[k] += Math.log(power[k] / Math.max(1, frames) + 1e-20);
    }
  }
  const freqs = new Float64Array(fftSize / 2 + 1);
  const gain = new Float64Array(fftSize / 2 + 1);
  for (let k = 0; k <= fftSize / 2; k++) {
    freqs[k] = (k * sampleRate) / fftSize;
    gain[k] = Math.exp(logPower[k] / channels.length);
  }
  // 归一化到中低频中位数
  const refLo = Math.max(1, Math.floor(500 / (sampleRate / fftSize)));
  const refHi = Math.max(refLo + 1, Math.ceil(2000 / (sampleRate / fftSize)));
  const refVals: number[] = [];
  for (let k = refLo; k <= refHi; k++) refVals.push(gain[k]);
  refVals.sort((a, b) => a - b);
  const refGain = refVals[Math.floor(refVals.length / 2)];
  if (refGain > 1e-12) for (let k = 0; k < gain.length; k++) gain[k] /= refGain;
  return { freqs, gain };
}

export interface EqDesignOptions {
  /** FIR 阶数（实际长度 taps+1，取奇数） */
  taps?: number;
  /** 最大提升量 dB，防止噪声过度放大 */
  maxBoostDb?: number;
  /** 目标参考带响应：默认平直（1.0） */
  targetDb?: (freqHz: number) => number;
  /** 自检迭代次数，保证 10kHz 残差 */
  iterations?: number;
}

/**
 * 由"实测受损响应"设计线性相位 FIR 逆补偿滤波器。
 *
 * 步骤：频域求逆 → 正则化限幅 → 频率采样法（在大 FFT 网格上 IDFT
 * 取因果 FIR）→ Hann 窗截断 → 卷积实测响应自检 10kHz 残差
 * → 不达标则在目标上叠加修正再迭代。
 */
export function designInverseEq(
  measuredFreqs: Float64Array,
  measuredGain: Float64Array,
  sampleRate: number,
  opts: EqDesignOptions = {},
): {
  fir: Float32Array;
  freqs: Float32Array;
  targetGain: Float32Array;
  measuredGain: Float32Array;
  residualAt10kDb: number;
} {
  const taps = opts.taps ?? 255;
  const firLen = taps + 1; // 偶数长度，群延迟 = (firLen-1)/2 为半样本，幅度计算不受影响
  const maxBoost = Math.pow(10, (opts.maxBoostDb ?? 18) / 20);
  const targetDb = opts.targetDb ?? (() => 0);
  const iterations = opts.iterations ?? 4;
  const gridN = 2048; // 频率采样网格，远大于 FIR 长度以保证 IDFT 精度

  // 把实测响应重采样到设计网格（0..Nyquist）
  const gridGain = new Float64Array(gridN / 2 + 1);
  const gridFreq = new Float64Array(gridN / 2 + 1);
  for (let i = 0; i <= gridN / 2; i++) {
    const f = (i * sampleRate) / gridN;
    gridFreq[i] = f;
    gridGain[i] = interpLogFreq(measuredFreqs, measuredGain, f);
  }
  // 对数域 1/12 倍频程平滑：消除方位角分数延迟造成的窄梳状干涉谷，
  // 保留间隙损耗的宽带滚降趋势——逆补偿只应跟踪平滑的频谱包络。
  smoothLogResponse(gridGain, gridFreq, 1 / 12);

  let correctionDb = new Float64Array(gridN / 2 + 1);
  let fir = new Float32Array(firLen);
  let residual = Infinity;
  const win = hannWindow(firLen);

  for (let iter = 0; iter < iterations; iter++) {
    // 1) 目标幅度：参考带目标 / 实测受损响应，限幅后叠加历史修正
    const desired = new Float64Array(gridN / 2 + 1);
    for (let i = 0; i <= gridN / 2; i++) {
      const targetLin = Math.pow(10, targetDb(gridFreq[i]) / 20);
      let g = targetLin / Math.max(gridGain[i], 1e-5);
      g *= Math.pow(10, correctionDb[i] / 20);
      desired[i] = Math.min(maxBoost, Math.max(1 / maxBoost, g));
    }
    // 2) 构造双边幅度谱（实偶对称，线性相位对应零相位原型）
    const mag = new Float64Array(gridN);
    for (let i = 0; i <= gridN / 2; i++) mag[i] = desired[i];
    for (let i = 1; i < gridN / 2; i++) mag[gridN - i] = desired[i];
    // 3) IDFT 得到零相位冲激响应 h0[n]（实信号，只算余弦和）
    const h0 = new Float64Array(gridN);
    for (let n = 0; n < gridN; n++) {
      let s = mag[0];
      for (let k = 1; k < gridN / 2; k++) s += 2 * mag[k] * Math.cos((2 * Math.PI * k * n) / gridN);
      s += mag[gridN / 2] * Math.cos(Math.PI * n);
      h0[n] = s / gridN;
    }
    // 4) 取 [-half, half] 的中心段并加 Hann 窗，变成因果线性相位 FIR
    const half = firLen >> 1;
    for (let n = 0; n < firLen; n++) {
      const m = n - half;
      const idx = m < 0 ? gridN + m : m;
      fir[n] = h0[idx] * win[n];
    }
    // 5) 自检：FIR 与实测响应级联后在 10kHz 相对目标的残差
    const resp = firMagnitudeAt(fir, 10000, sampleRate);
    const measuredAt10k = interpLogFreq(measuredFreqs, measuredGain, 10000);
    const targetAt10k = Math.pow(10, targetDb(10000) / 20);
    residual = 20 * Math.log10((resp * measuredAt10k) / targetAt10k + 1e-12);
    // 下一轮把残差反向折进修正项
    for (let i = 0; i <= gridN / 2; i++) correctionDb[i] -= residual * 0.8;
  }

  return {
    fir,
    freqs: Float32Array.from(gridFreq),
    targetGain: Float32Array.from(gridFreq.map(f => Math.pow(10, targetDb(f) / 20))),
    measuredGain: Float32Array.from(gridGain),
    residualAt10kDb: residual,
  };
}

/** FIR 在指定频率处的幅度（线性） */
export function firMagnitudeAt(fir: ArrayLike<number>, freqHz: number, sampleRate: number): number {
  const w = (2 * Math.PI * freqHz) / sampleRate;
  const center = (fir.length - 1) / 2;
  let re = 0, im = 0;
  for (let n = 0; n < fir.length; n++) {
    const phase = w * (n - center);
    re += fir[n] * Math.cos(phase);
    im -= fir[n] * Math.sin(phase);
  }
  return Math.hypot(re, im);
}

function interpLogFreq(freqs: ArrayLike<number>, gain: ArrayLike<number>, f: number): number {
  if (f <= freqs[0]) return gain[0];
  for (let i = 1; i < freqs.length; i++) {
    if (f <= freqs[i]) {
      const u = Math.log(f / freqs[i - 1]) / Math.log(freqs[i] / freqs[i - 1] + 1e-12);
      return gain[i - 1] * (1 - u) + gain[i] * u;
    }
  }
  return gain[gain.length - 1];
}

/**
 * 对数域分数倍频程平滑。octaveFraction 为平滑带宽占一个倍频程的比例
 * （1/12 即 1/12 倍频程）。在 dB 域做移动平均，原地修改 gainLin。
 * 频率网格近似线性，用半窗索引做 O(n) 滑动平均。
 */
function smoothLogResponse(gainLin: Float64Array, freqs: Float64Array, octaveFraction: number): void {
  const n = gainLin.length;
  const db = new Float64Array(n);
  for (let i = 0; i < n; i++) db[i] = 20 * Math.log10(Math.max(gainLin[i], 1e-7));
  const out = new Float64Array(n);
  const half = octaveFraction / 2;
  for (let i = 0; i < n; i++) {
    const f0 = Math.max(freqs[1], freqs[i]);
    // 线性网格下，倍频程半窗对应的 bin 宽度随频率正比增长
    const binHz = freqs[1] - freqs[0];
    const winBins = Math.max(1, Math.round((f0 * (Math.pow(2, half) - 1)) / binHz));
    const lo = Math.max(0, i - winBins);
    const hi = Math.min(n - 1, i + winBins);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += db[j];
    out[i] = sum / (hi - lo + 1);
  }
  for (let i = 0; i < n; i++) gainLin[i] = Math.pow(10, out[i] / 20);
}

/** 流式 FIR 卷积器（直接型，状态可续算；255 阶在 worklet 中足够便宜） */
export class FirFilter {
  private history: Float32Array;

  constructor(private coeffs: Float32Array) {
    this.history = new Float32Array(coeffs.length);
  }

  process(x: number): number {
    this.history.copyWithin(0, 1);
    this.history[this.history.length - 1] = x;
    let s = 0;
    for (let i = 0; i < this.coeffs.length; i++) s += this.coeffs[i] * this.history[i];
    return s;
  }

  processBlock(input: Float32Array): Float32Array {
    const m = this.coeffs.length;
    const n = input.length;
    const out = new Float32Array(n);
    // 拼接历史（m-1 个）+ 当前块，一次性做整块卷积，避免逐样本 copyWithin
    const buf = new Float32Array(m - 1 + n);
    buf.set(this.history.subarray(1), 0);
    buf.set(input, m - 1);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < m; j++) s += this.coeffs[j] * buf[i + j];
      out[i] = s;
    }
    // 更新历史为 buf 末尾 m 个样本（保持逐样本 process 的状态语义）
    this.history.set(buf.subarray(buf.length - m));
    return out;
  }

  getState() {
    return { history: Float32Array.from(this.history) };
  }

  setState(s: ReturnType<FirFilter['getState']>): void {
    this.history.set(s.history);
  }
}

/** RBJ 双二阶陷波器，用于残余交流哼声（可级联 50+100Hz 等） */
export class BiquadNotch {
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;

  constructor(private freqHz: number, private q: number, private sampleRate: number) {
    this.design();
  }

  private design(): void {
    const w0 = (2 * Math.PI * this.freqHz) / this.sampleRate;
    const alpha = Math.sin(w0) / (2 * this.q);
    const a0 = 1 + alpha;
    this.b0 = 1 / a0;
    this.b1 = (-2 * Math.cos(w0)) / a0;
    this.b2 = this.b0;
    this.a1 = this.b1;
    this.a2 = (1 - alpha) / a0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}
