import type { DriftPoint, WowFlutterReport } from './types';

/** 流式中值滤波器（O(k log k) 每次用排序，k 很小，足够） */
class MedianFilter {
  private readonly buf: number[] = [];
  constructor(private readonly k: number) {}
  push(v: number): number {
    this.buf.push(v);
    if (this.buf.length > this.k) this.buf.shift();
    const sorted = [...this.buf].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  }
}

/** 一阶 IIR 低通（零相位：正向+反向各滤一遍，等效二阶、截止更陡） */
function zeroPhaseLowpass(x: number[], cutoffHz: number, sampleRate: number): number[] {
  // 一阶 RC 后向差分：α = (2πfc·T)/(1+2πfc·T)；双向串接等效二阶零相位
  const t = 1 / sampleRate;
  const alpha = (2 * Math.PI * cutoffHz * t) / (1 + 2 * Math.PI * cutoffHz * t);
  const fwd = new Array<number>(x.length);
  let acc = x[0];
  for (let i = 0; i < x.length; i++) {
    acc += alpha * (x[i] - acc);
    fwd[i] = acc;
  }
  const out = new Array<number>(x.length);
  acc = fwd[fwd.length - 1];
  for (let i = fwd.length - 1; i >= 0; i--) {
    acc += alpha * (fwd[i] - acc);
    out[i] = acc;
  }
  return out;
}

/**
 * 抖晃跟踪核（块级 DFT 锁相测量）。
 *
 * 原理（测量级频率计思路）：对每个分析块，在标称频率 f0 处做单 bin
 * DFT（Goertzel 等价），得到复分量 Z_k。相邻块的相位差
 *   Δφ = arg(Z_k · conj(Z_{k−1}))
 * 解缠绕后，块内平均瞬时频率
 *   f_inst = f0 + Δφ/(2π·T)
 * 速度比 s = f_inst / f0。
 * 块内整段积分相当于极窄带相干接收，对宽带节目与噪声的抑制能力远强于
 * 逐样本一阶低通；相干度用 |ΣZ|/Σ|Z| 估计。逐样本流式、可在 Worklet 运行。
 */
export class WowFlutterTracker {
  readonly sampleRate: number;
  readonly f0: number;
  readonly blockSize: number;
  readonly bandwidthHz: number;

  private phase = 0;
  private blockRe = 0;
  private blockIm = 0;
  private blockEnergy = 0;
  private blockCount = 0;
  private sampleIndex = 0;
  private prevZre = 0;
  private prevZim = 0;
  private hasPrev = false;
  private cohNumRe = 0;
  private cohNumIm = 0;
  private cohDen = 0;
  private readonly cohWindow = 16;
  private cohHistory: Array<[number, number]> = [];

  constructor(sampleRate: number, f0: number, blockSize = 256, bandwidthHz = 120) {
    if (f0 <= 0 || f0 >= sampleRate / 2) throw new Error('参考音频率超出奈奎斯特范围');
    this.sampleRate = sampleRate;
    this.f0 = f0;
    this.blockSize = blockSize;
    this.bandwidthHz = bandwidthHz;
  }

  /** 处理一个（单声道/已下混）样本，返回本块结束时的 DriftPoint，否则 null */
  process(x: number): DriftPoint | null {
    const w = (2 * Math.PI * this.f0) / this.sampleRate;
    // 单 bin DFT：Z = Σ x[n]·e^{−jωn}
    this.blockRe += x * Math.cos(this.phase);
    this.blockIm -= x * Math.sin(this.phase);
    this.phase += w;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    this.blockEnergy += x * x;

    this.blockCount++;
    this.sampleIndex++;
    if (this.blockCount < this.blockSize) return null;

    // 块间相位差（解缠绕）。相干系数 γ=|ZₖZ*ₖ₋₁|/(|Zₖ||Zₖ₋₁|)
    // 恒等于 1（两个复数的夹角），因此用滑动窗向量相干度给整块降权。
    let ratio = 1;
    let coherence = 0;
    if (this.hasPrev) {
      const crossRe = this.blockRe * this.prevZre + this.blockIm * this.prevZim;
      const crossIm = this.blockIm * this.prevZre - this.blockRe * this.prevZim;
      let dPhi = Math.atan2(crossIm, crossRe);
      // 块间允许的最大相位变化受带宽约束；超出则缠绕修正
      const maxPhi = (Math.PI * this.bandwidthHz * this.blockSize) / this.sampleRate;
      while (dPhi > maxPhi) dPhi -= 2 * Math.PI;
      while (dPhi < -maxPhi) dPhi += 2 * Math.PI;
      const T = this.blockSize / this.sampleRate;
      const fInst = this.f0 + dPhi / (2 * Math.PI * T);
      ratio = fInst / this.f0;

      // 相干度：滑动窗口内复分量向量和的模长 / 模长和（纯音→1，噪声→0）
      this.cohHistory.push([this.blockRe, this.blockIm]);
      if (this.cohHistory.length > this.cohWindow) this.cohHistory.shift();
      let numRe = 0, numIm = 0, den = 0;
      for (const [re, im] of this.cohHistory) {
        numRe += re; numIm += im;
        den += Math.hypot(re, im);
      }
      this.cohNumRe = numRe;
      this.cohNumIm = numIm;
      this.cohDen = den + 1e-12;
      coherence = Math.min(1, Math.hypot(numRe, numIm) / this.cohDen);
    }

    const point: DriftPoint = {
      t: (this.sampleIndex - this.blockSize / 2) / this.sampleRate,
      ratio,
      level: Math.sqrt(this.blockEnergy / this.blockSize),
      coherence,
    };
    this.prevZre = this.blockRe;
    this.prevZim = this.blockIm;
    this.hasPrev = true;
    this.blockRe = 0;
    this.blockIm = 0;
    this.blockEnergy = 0;
    this.blockCount = 0;
    return point;
  }

  /** 取出可结构化克隆的内部状态，用于分块处理间续算 */
  getState() {
    return {
      phase: this.phase, blockRe: this.blockRe, blockIm: this.blockIm,
      blockEnergy: this.blockEnergy, blockCount: this.blockCount,
      sampleIndex: this.sampleIndex, prevZre: this.prevZre, prevZim: this.prevZim,
      hasPrev: this.hasPrev, cohNumRe: this.cohNumRe, cohNumIm: this.cohNumIm, cohDen: this.cohDen,
      cohHistory: this.cohHistory.map(([re, im]) => [re, im] as [number, number]),
    };
  }

  setState(s: ReturnType<WowFlutterTracker['getState']>): void {
    Object.assign(this, s);
  }
}

/** 线性插值取任意时刻的速度比（曲线外的点用端点值钳制） */
export function sampleRatioAt(curve: DriftPoint[], t: number): number {
  if (curve.length === 0) return 1;
  if (t <= curve[0].t) return curve[0].ratio;
  const last = curve[curve.length - 1];
  if (t >= last.t) return last.ratio;
  // 二分查找
  let lo = 0, hi = curve.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = curve[lo], b = curve[hi];
  const u = (t - a.t) / (b.t - a.t);
  return a.ratio * (1 - u) + b.ratio * u;
}

/**
 * 后处理：剔除不可信块 → 中值去野点 → 线性补洞 → 轻度移动平均。
 * 平滑窗口刻意取小：块率约 187.5Hz，窗 3 仅抑制 30Hz 以上的估计噪声，
 * 保留 0.5–60Hz 的真实抖晃分量。输出可直接喂给变速重采样器。
 */
export function buildCorrectionCurve(points: DriftPoint[], opts: {
  coherenceGate?: number;
  levelGate?: number;
  medianK?: number;
  smoothK?: number;
} = {}): DriftPoint[] {
  const coherenceGate = opts.coherenceGate ?? 0.25;
  const levelGate = opts.levelGate ?? 1e-4;
  const medianK = opts.medianK ?? 5;
  const smoothK = opts.smoothK ?? 3;
  if (points.length === 0) return [];

  const noiseFloor = Math.max(1e-6, 0.25 * median(points.map(p => p.level)));
  const gate = Math.max(levelGate, noiseFloor);
  // 1) 门限：不可信块 ratio 置空
  const raw = points.map(p =>
    p.coherence >= coherenceGate && p.level >= gate ? p.ratio : NaN,
  );

  // 2) 可信块上做中值滤波（野点替换为局部中值），再回填
  const med = new MedianFilter(medianK);
  const cleaned = raw.map(v => (Number.isNaN(v) ? NaN : med.push(v)));

  // 3) 线性插值补洞
  const filled = [...cleaned];
  let i = 0;
  while (i < filled.length) {
    if (!Number.isNaN(filled[i])) { i++; continue; }
    const left = i - 1;
    let j = i;
    while (j < filled.length && Number.isNaN(filled[j])) j++;
    const right = j;
    const lv = left >= 0 ? filled[left] : NaN;
    const rv = right < filled.length ? filled[right] : NaN;
    if (Number.isNaN(lv) && Number.isNaN(rv)) for (let k = i; k < j; k++) filled[k] = 1;
    else if (Number.isNaN(lv)) for (let k = i; k < j; k++) filled[k] = rv;
    else if (Number.isNaN(rv)) for (let k = i; k < j; k++) filled[k] = lv;
    else for (let k = i; k < j; k++) filled[k] = lv + ((rv - lv) * (k - left)) / (right - left);
    i = j;
  }

  // 4) 相干度加权移动平均（低可信块降权而非丢弃，避免补洞制造伪变化）
  const half = smoothK >> 1;
  const out: DriftPoint[] = points.map((p, idx) => {
    let sum = 0, wsum = 0;
    for (let k = Math.max(0, idx - half); k <= Math.min(filled.length - 1, idx + half); k++) {
      const w = 0.25 + 0.75 * points[k].coherence;
      sum += filled[k] * w;
      wsum += w;
    }
    return { ...p, ratio: sum / wsum };
  });
  return out;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** 由校正曲线计算抖晃指标：wow=0.5–6Hz 慢漂移，flutter=6–60Hz 快抖晃 */
export function summarizeWowFlutter(curve: DriftPoint[], source: string): WowFlutterReport {
  if (curve.length < 8) {
    return { curve, wowFlutterPct: 0, wowRmsPct: 0, flutterRmsPct: 0, source };
  }
  // 去掉首尾各 5% 的瞬态段（滤波器建立/结尾零填影响）
  const margin = Math.max(1, Math.floor(curve.length * 0.05));
  const inner = curve.slice(margin, curve.length - margin);
  const dt = (inner[inner.length - 1].t - inner[0].t) / (inner.length - 1);
  const rate = 1 / dt;
  const dev = inner.map(p => p.ratio - 1);

  // 6Hz 以下的慢变化（零相位低通）
  const wow = zeroPhaseLowpass(dev, 6, rate);
  const flutter = dev.map((v, i) => v - wow[i]);

  const rmsPct = (x: number[]) =>
    Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length) * 100;
  const wowRmsPct = rmsPct(wow);
  const flutterRmsPct = rmsPct(flutter);
  // 峰峰值（1%–99% 分位，抗野点）
  const sorted = [...dev].sort((a, b) => a - b);
  const pk = (sorted[Math.floor(0.99 * sorted.length)] - sorted[Math.floor(0.01 * sorted.length)]) * 100;
  return {
    curve,
    wowFlutterPct: pk,
    wowRmsPct,
    flutterRmsPct,
    source,
  };
}
