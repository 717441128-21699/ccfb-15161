/**
 * 参考音 / 交流哼声跟踪：加窗正交解调（I/Q）估计瞬时播放速率。
 *
 * 对每个 hop 推进的分析帧，独立做 Hann 加窗的 I/Q 解调：
 *     I = Σ w[n]·x[n]·cos(2π f0 n/fs)
 *     Q = Σ w[n]·x[n]·sin(2π f0 n/fs)
 * 基带复包络 z=I+jQ 的辐角是参考分量相对额定频率的瞬时相位。
 * 相邻帧（起点相隔 hop）的相位差给出频率偏差：
 *     f_inst = f0 - Δφ·fs/(2π·hop)
 *
 * Hann 窗使低通通带平坦、旁瓣抑制充分，避免节目宽带能量在基带
 * 形成周期性抵消；帧与帧之间无滑动积分的状态残留，相位参考稳定。
 * 哼声的多个谐波各自解调后按功率加权融合。
 */

export interface TrackerConfig {
  sampleRate: number;
  referenceHz: number;
  harmonics?: number[];
  frameSize?: number;
  hopSize?: number;
}

export interface TrackPoint {
  t: number;
  rate: number;
  confidence: number;
}

/** 单谐波加窗 I/Q 解调，逐帧调用。 */
class HarmonicDemod {
  private phaseInc: number;
  private prevPhase: number | null = null;

  constructor(
    private freqHz: number,
    private fs: number,
    private frameSize: number,
    private hop: number,
    private window: Float64Array,
  ) {
    this.phaseInc = (2 * Math.PI * freqHz) / fs;
  }

  /** 分析一帧（signal[start..start+n)），返回速率与置信度相关量。 */
  analyze(signal: ArrayLike<number>, start: number, frameEnergy: number): {
    rate: number | null;
    power: number;
    confidence: number;
  } {
    const n = this.frameSize;
    let I = 0;
    let Q = 0;
    // 递归 NCO：每样本一次复数旋转，避免逐样本 Math.cos/sin（长音频关键路径）
    let cosW = Math.cos(this.phaseInc * start);
    let sinW = Math.sin(this.phaseInc * start);
    const cosInc = Math.cos(this.phaseInc);
    const sinInc = Math.sin(this.phaseInc);
    for (let i = 0; i < n; i++) {
      const wv = this.window[i];
      const x = signal[start + i] * wv;
      I += x * cosW;
      Q += x * sinW;
      const nc = cosW * cosInc - sinW * sinInc;
      sinW = cosW * sinInc + sinW * cosInc;
      cosW = nc;
    }
    // Hann 窗相干增益 0.5，归一化幅度
    I *= 2 / n;
    Q *= 2 / n;
    const power = I * I + Q * Q;
    const phase = Math.atan2(Q, I);
    const confidence = Math.min(1, power / (frameEnergy + 1e-12));

    if (this.prevPhase === null) {
      this.prevPhase = phase;
      return { rate: null, power, confidence };
    }
    let dphi = phase - this.prevPhase;
    dphi = Math.atan2(Math.sin(dphi), Math.cos(dphi));
    this.prevPhase = phase;
    // 信号 sin(ωt) 与 (cos,sin) NCO 混频，频率偏高时基带相位递减，取负号
    const deltaF = -(dphi * this.fs) / (2 * Math.PI * this.hop);
    return { rate: (this.freqHz + deltaF) / this.freqHz, power, confidence };
  }
}

function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

export function trackRate(signal: ArrayLike<number>, cfg: TrackerConfig): {
  points: TrackPoint[];
  ratesPerSecond: Float64Array;
} {
  const fs = cfg.sampleRate;
  const harmonics = cfg.harmonics ?? [1];
  const n = cfg.frameSize ?? 4096;
  const hop = cfg.hopSize ?? n >> 2;
  const duration = signal.length / fs;
  const window = hannWindow(n);
  const demods = harmonics.map((h) => new HarmonicDemod(cfg.referenceHz * h, fs, n, hop, window));
  const points: TrackPoint[] = [];

  for (let start = 0; start + n <= signal.length; start += hop) {
    // 加窗帧能量（与解调同量纲）
    let frameEnergy = 0;
    for (let i = 0; i < n; i++) {
      const v = signal[start + i] * window[i];
      frameEnergy += v * v;
    }
    frameEnergy *= 2 / n; // 与 I/Q 相同的归一化

    let rateSum = 0;
    let wSum = 0;
    let confSum = 0;
    for (const d of demods) {
      const r = d.analyze(signal, start, frameEnergy);
      if (r.rate !== null && r.rate > 0.85 && r.rate < 1.15 && r.confidence > 1e-6) {
        rateSum += r.rate * r.power;
        wSum += r.power;
        confSum += r.confidence;
      }
    }
    if (wSum > 0) {
      points.push({
        t: (start + n / 2) / fs,
        rate: rateSum / wSum,
        confidence: Math.min(1, confSum / harmonics.length),
      });
    }
  }

  const seconds = Math.max(1, Math.ceil(duration));
  const ratesPerSecond = new Float64Array(seconds).fill(1);
  const weights = new Float64Array(seconds);
  for (const p of points) {
    const i = Math.min(seconds - 1, Math.max(0, Math.floor(p.t)));
    const w = p.confidence;
    ratesPerSecond[i] = (ratesPerSecond[i] * weights[i] + p.rate * w) / (weights[i] + w);
    weights[i] += w;
  }
  for (let i = 0; i < seconds; i++) {
    if (weights[i] === 0) ratesPerSecond[i] = i > 0 ? ratesPerSecond[i - 1] : 1;
  }
  return { points, ratesPerSecond };
}

/** 三点中值平滑，抑制估计噪声，保留抖晃趋势。 */
export function smoothRateMap(ratesPerSecond: Float64Array): Float64Array {
  const out = new Float64Array(ratesPerSecond.length);
  for (let i = 0; i < out.length; i++) {
    const a = ratesPerSecond[Math.max(0, i - 1)];
    const b = ratesPerSecond[i];
    const c = ratesPerSecond[Math.min(out.length - 1, i + 1)];
    out[i] = a + b + c - Math.min(a, b, c) - Math.max(a, b, c);
  }
  return out;
}
