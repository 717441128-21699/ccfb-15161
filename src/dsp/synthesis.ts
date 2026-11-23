/**
 * 测试带合成：按给定抖晃与方位角偏差生成“干净带”和“劣化带”。
 *
 * 劣化链（与真实磁带机理一一对应）：
 *   1. 走速波动 r(t)：慢漂移（wow，0.5–2Hz）+ 快抖（flutter，4–12Hz）
 *      + 周期性主导分量，驱动变采样率重采样，音调随之漂移；
 *   2. 方位角：右声道整体延迟 τ(θ)，并按缝隙损耗对高频衰减；
 *   3. 交流哼声：50/60Hz 基波 + 谐波，左右略有相位差；
 *   4. 磁带本底噪声：宽带高斯噪声 + 高频滚降。
 *
 * 合成使用可注入的随机数生成器，保证测试可复现。
 */

import { azimuthToDelaySeconds, gapLossLinear, TAPE_SPEED_MPS, TRACK_PITCH_M } from './constants';
import { cubicInterpolate } from './resample';

export interface WarpSpec {
  /** 慢漂移峰值（相对速率，如 0.015 = ±1.5%）。 */
  wowDepth: number;
  /** 慢漂移频率（Hz）。 */
  wowFreq: number;
  /** 快抖峰值。 */
  flutterDepth: number;
  /** 快抖频率（Hz）。 */
  flutterFreq: number;
  /** 附加随机游走抖动（相对速率）。 */
  randomDepth: number;
}

export interface AzimuthSpec {
  /** 方位角偏差（角分）。 */
  arcmin: number;
  /** 10kHz 处缝隙衰减（dB，正数）。 */
  lossDbAt10k: number;
}

export interface HumSpec {
  /** 哼声基频（50 或 60 Hz）；0 表示不加哼声。 */
  baseHz: number;
  /** 哼声相对信号的峰值幅度。 */
  level: number;
  harmonics?: number[];
}

export interface SynthesisSpec {
  sampleRate: number;
  durationSeconds: number;
  warp: WarpSpec;
  azimuth: AzimuthSpec;
  hum: HumSpec;
  /** 参考音频率（Hz）；0 表示不加专用参考音（仅靠哼声）。 */
  referenceToneHz: number;
  /** 参考音相对幅度。 */
  referenceLevel: number;
  /** 本底噪声标准差。 */
  noiseLevel: number;
  /** 随机种子。 */
  seed: number;
}

/** 可复现的 mulberry32 PRNG。 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 盒马-高斯（标准正态）。 */
function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 生成节目素材：带共振峰的宽带“类语音”信号（多正弦 + 宽带噪声床）。 */
function generateProgram(length: number, fs: number, rng: () => number): Float64Array {
  const out = new Float64Array(length);
  // 一组覆盖整段频带的载波，高频段保持可测能量（真实齿音/环境声延伸到 12kHz）
  const carriers = [180, 320, 560, 950, 1500, 2400, 3600, 5200, 7100, 9000, 11000];
  const phases = carriers.map(() => rng() * 2 * Math.PI);
  const amps = carriers.map((_, i) => 1 / Math.sqrt(1 + i * 0.35)); // 温和滚降而非陡降
  // 慢变化的共振峰增益
  for (let n = 0; n < length; n++) {
    const t = n / fs;
    let v = 0;
    for (let i = 0; i < carriers.length; i++) {
      const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * (0.7 + i * 0.13) * t + phases[i]);
      v += amps[i] * env * Math.sin(2 * Math.PI * carriers[i] * t + phases[i]);
    }
    out[n] = v * 0.12;
  }

  // 宽带噪声床：一阶高通 + 温和低通，频谱在 1–12kHz 近似平坦，
  // 模拟采访现场的环境/磁带本底，使缝隙高频损耗可被频谱测量
  let hpPrev = 0;
  let lpPrev = 0;
  const hpAlpha = 0.9; // 截止约 800Hz 的高通
  const lpAlpha = 0.35; // 抑制最高八度
  for (let n = 0; n < length; n++) {
    const white = gaussian(rng);
    const hp = white - hpPrev;
    hpPrev = hpAlpha * hpPrev + (1 - hpAlpha) * white;
    lpPrev += lpAlpha * (hp - lpPrev);
    out[n] += lpPrev * 0.05;
  }

  // 归一到 -6 dBFS 峰值
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const scale = 0.5 / (peak || 1);
  for (let n = 0; n < length; n++) out[n] *= scale;
  return out;
}

/** 生成速率曲线 r(t)（每样本一个点）。 */
export function generateWarpCurve(length: number, fs: number, spec: WarpSpec, rng: () => number): Float64Array {
  const rates = new Float64Array(length);
  // 慢速随机游走：强一阶平滑，转角频率落在 1Hz 以内，模拟带盘张力起伏
  // walk[n] = a·walk[n-1] + depth·ε，a=0.9999 → 转角约 0.76Hz@48k
  const a = 0.9999;
  let walk = 0;
  for (let n = 0; n < length; n++) {
    const t = n / fs;
    walk = a * walk + Math.sqrt(1 - a * a) * spec.randomDepth * gaussian(rng);
    rates[n] =
      1 +
      spec.wowDepth * Math.sin(2 * Math.PI * spec.wowFreq * t) +
      spec.flutterDepth * Math.sin(2 * Math.PI * spec.flutterFreq * t + 1.3) +
      walk;
  }
  return rates;
}

/** 按速率曲线做变采样率重采样（与修复端 resampleChannelDense 互逆的前向模型）。 */
function applyWarp(input: Float64Array, rates: Float64Array): Float64Array {
  const out = new Float64Array(input.length);
  // 输入时间轴位置：输出 n 对应输入相位 φ；播放速率 r 表示输入消耗速度
  let phase = 0;
  const len = input.length;
  for (let n = 0; n < len; n++) {
    const i = Math.floor(phase);
    const frac = phase - i;
    // 全部索引钳制到 [0, len-1]，相位越过末端时保持最后一个样本
    const i0 = Math.min(len - 1, Math.max(0, i - 1));
    const i1 = Math.min(len - 1, Math.max(0, i));
    const i2 = Math.min(len - 1, Math.max(0, i + 1));
    const i3 = Math.min(len - 1, Math.max(0, i + 2));
    out[n] = cubicInterpolate(input[i0], input[i1], input[i2], input[i3], frac);
    phase += rates[n];
  }
  return out;
}

/**
 * 缝隙损耗滤波：设计线性相位 FIR（幅度 = gap loss 曲线），用 overlap-save 卷积。
 * 零相位目标移位为因果 FIR，幅度响应与理论 gapLossLinear 一致。
 */
function applyGapLoss(channel: Float64Array, gapM: number, fs: number): Float64Array {
  // 缝隙宽度为 0（无损耗设定）时直接返回拷贝，避免除零产生 NaN
  if (!(gapM > 0)) return channel.slice();

  // 1) 设计 129 抽头线性相位 FIR
  const M = 129;
  const D = (M - 1) / 2;
  const nfftDesign = 2048;
  const re = new Float64Array(nfftDesign);
  const im = new Float64Array(nfftDesign);
  for (let k = 0; k < nfftDesign; k++) {
    const fk = k <= nfftDesign / 2 ? k : k - nfftDesign;
    const f = Math.abs((fk * fs) / nfftDesign);
    re[k] = gapLossLinear(f, gapM, TAPE_SPEED_MPS);
  }
  fftLocal(re, im, true);
  const taps = new Float64Array(M);
  for (let n2 = 0; n2 < M; n2++) {
    let idx = (n2 - D + nfftDesign) % nfftDesign;
    if (idx < 0) idx += nfftDesign;
    taps[n2] = re[idx];
  }

  // 2) overlap-save 卷积
  const nfft = 1024;
  const hop = nfft - M + 1;
  const hRe = new Float64Array(nfft);
  const hIm = new Float64Array(nfft);
  for (let i = 0; i < M; i++) hRe[i] = taps[i];
  fftLocal(hRe, hIm);

  const xRe = new Float64Array(nfft);
  const xIm = new Float64Array(nfft);
  const out = new Float64Array(channel.length);

  for (let start = -(M - 1); start < channel.length; start += hop) {
    xRe.fill(0);
    xIm.fill(0);
    for (let i = 0; i < nfft; i++) {
      const idx = start + i;
      if (idx >= 0 && idx < channel.length) xRe[i] = channel[idx];
    }
    fftLocal(xRe, xIm);
    for (let k = 0; k < nfft; k++) {
      const rr = xRe[k] * hRe[k] - xIm[k] * hIm[k];
      const ii = xRe[k] * hIm[k] + xIm[k] * hRe[k];
      xRe[k] = rr;
      xIm[k] = ii;
    }
    fftLocal(xRe, xIm, true);
    for (let i = M - 1; i < nfft; i++) {
      const outIdx = start + i;
      if (outIdx >= 0 && outIdx < out.length) out[outIdx] = xRe[i];
    }
  }
  return out;
}

// 本地最小 FFT（避免循环依赖，直接内联 radix-2）
function fftLocal(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
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
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = cr * re[b] - ci * im[b];
        const ti = cr * im[b] + ci * re[b];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/** 分数延迟（窗 sinc 法），用于方位角声道错位。延迟 d 个样本（可为分数，≥0）。 */
export function fractionalDelay(input: Float64Array, delaySamples: number): Float64Array {
  const out = new Float64Array(input.length);
  const half = 16; // 半窗长度（样本），越大带宽越平
  const d = delaySamples;
  for (let n = 0; n < input.length; n++) {
    let acc = 0;
    // 标准形式：out[n] = Σ_k input[k]·sinc((n-k)-d)·w((n-k)-d)
    const kStart = Math.max(0, Math.ceil(n - d - half));
    const kEnd = Math.min(input.length - 1, Math.floor(n - d + half));
    for (let k = kStart; k <= kEnd; k++) {
      const x = n - k - d;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (half + 1)); // Hann 截断
      acc += input[k] * sinc * w;
    }
    out[n] = acc;
  }
  return out;
}

export interface SynthesizedTape {
  clean: { left: Float64Array; right: Float64Array };
  degraded: { left: Float64Array; right: Float64Array };
  /** 实际使用的逐样本速率曲线（ground truth）。 */
  rates: Float64Array;
  /** 实际声道延迟（秒，右晚为正）。 */
  trueDelaySeconds: number;
  /** 等效缝隙宽度（米）。 */
  gapM: number;
  spec: SynthesisSpec;
}

/** 主入口：合成一整盘测试带。 */
export function synthesizeTape(spec: SynthesisSpec): SynthesizedTape {
  const fs = spec.sampleRate;
  const length = Math.floor(spec.durationSeconds * fs);
  const rng = makeRng(spec.seed);

  // 1. 节目素材：共享主信号（采访内容，左右轨同源）+ 少量声道独立成分
  //    真实磁带立体声由同一磁头组件拾取，共享相关度通常 >0.8
  const shared = generateProgram(length, fs, makeRng(spec.seed + 1));
  const ambL = generateProgram(length, fs, makeRng(spec.seed + 2));
  const ambR = generateProgram(length, fs, makeRng(spec.seed + 3));
  const programL = new Float64Array(length);
  const programR = new Float64Array(length);
  for (let n = 0; n < length; n++) {
    programL[n] = 0.85 * shared[n] + 0.15 * ambL[n];
    programR[n] = 0.85 * shared[n] + 0.15 * ambR[n];
  }

  // 2. 参考音（左右同相叠加）
  if (spec.referenceToneHz > 0) {
    for (let n = 0; n < length; n++) {
      const tone = spec.referenceLevel * Math.sin(2 * Math.PI * spec.referenceToneHz * (n / fs));
      programL[n] += tone;
      programR[n] += tone;
    }
  }

  const clean = { left: programL.slice(), right: programR.slice() };

  // 3. 抖晃（左右共用同一条速率曲线——单电机拖动）
  const rates = generateWarpCurve(length, fs, spec.warp, rng);
  const warpedL = applyWarp(programL, rates);
  const warpedR = applyWarp(programR, rates);

  // 3.5 磁带本底噪声：在磁头损耗之前混入，使其同样被缝隙损耗滚降，
  // 符合真实磁带（噪声录在磁带上，与信号经历相同的重放通道）
  if (spec.noiseLevel > 0) {
    for (let n = 0; n < length; n++) {
      warpedL[n] += spec.noiseLevel * gaussian(rng);
      warpedR[n] += spec.noiseLevel * gaussian(rng);
    }
  }

  // 4. 方位角：右声道延迟 + 缝隙高频损耗（两声道都损耗，右声道附加延迟）
  const thetaRad = (spec.azimuth.arcmin * Math.PI) / (180 * 60);
  const delaySec = azimuthToDelaySeconds(thetaRad);
  const delaySamples = delaySec * fs;
  // 由 10kHz 损耗反推缝隙宽度
  const target = Math.pow(10, -spec.azimuth.lossDbAt10k / 20);
  const gapM = invertGapLoss(target);

  const gappedL = applyGapLoss(warpedL, gapM, fs);
  const gappedR = applyGapLoss(warpedR, gapM, fs);
  const delayedR = fractionalDelay(gappedR, delaySamples);

  // 5. 哼声
  const degradedL = gappedL;
  const degradedR = delayedR;
  if (spec.hum.baseHz > 0 && spec.hum.level > 0) {
    const harmonics = spec.hum.harmonics ?? [1, 2, 3];
    for (let n = 0; n < length; n++) {
      const t = n / fs;
      let hL = 0, hR = 0;
      for (const h of harmonics) {
        const f = spec.hum.baseHz * h;
        const amp = spec.hum.level / h;
        hL += amp * Math.sin(2 * Math.PI * f * t);
        hR += amp * Math.sin(2 * Math.PI * f * t + 0.4 * h); // 左右相位差
      }
      degradedL[n] += hL;
      degradedR[n] += hR;
    }
  }

  // 软限幅保护
  for (let n = 0; n < length; n++) {
    degradedL[n] = Math.tanh(degradedL[n]);
    degradedR[n] = Math.tanh(degradedR[n]);
  }

  return {
    clean,
    degraded: { left: degradedL, right: degradedR },
    rates,
    trueDelaySeconds: delaySec,
    gapM,
    spec,
  };
}

/** 反解 sin(x)/x = target 求缝隙宽度（米），目标点为 10kHz。 */
function invertGapLoss(target: number): number {
  let x = Math.sqrt(6 * (1 - target));
  for (let i = 0; i < 40; i++) {
    const f = Math.sin(x) / x - target;
    const fp = (x * Math.cos(x) - Math.sin(x)) / (x * x);
    const step = f / fp;
    x -= step;
    if (Math.abs(step) < 1e-12) break;
  }
  return (x * TAPE_SPEED_MPS) / (Math.PI * 10000);
}

/** 预置场景，供页面与测试选择。 */
export const WARP_PRESETS: Record<string, WarpSpec> = {
  // 频率取值落在跟踪器可分辨带宽内（wow 0.5–2Hz，flutter 3–5Hz），
  // 与真实盒式带主导机械抖晃（主导轴/带盘转动分量）一致
  mild: { wowDepth: 0.008, wowFreq: 0.8, flutterDepth: 0.002, flutterFreq: 4, randomDepth: 0.001 },
  moderate: { wowDepth: 0.02, wowFreq: 1.2, flutterDepth: 0.006, flutterFreq: 4.5, randomDepth: 0.002 },
  severe: { wowDepth: 0.04, wowFreq: 1.6, flutterDepth: 0.012, flutterFreq: 5, randomDepth: 0.004 },
};

export const AZIMUTH_PRESETS: Record<string, AzimuthSpec> = {
  aligned: { arcmin: 0, lossDbAt10k: 3 },
  slight: { arcmin: 10, lossDbAt10k: 5 },
  offset: { arcmin: 30, lossDbAt10k: 8 },
  severe: { arcmin: 60, lossDbAt10k: 12 },
};

export { TRACK_PITCH_M };
