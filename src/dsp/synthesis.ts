import { angleToDelay } from './azimuth';
import { gapLossResponse } from './eq-design';
import { hannWindow } from './fft';
import { RAD_PER_ARCMIN, type SyntheticGroundTruth, type TapeSpec } from './types';
import { catmullRom } from './resampler';

export interface ScenarioParams {
  /** 场景标识 */
  scenario: string;
  durationSec: number;
  sampleRate: number;
  /** 方位角偏差（角分） */
  azimuthArcmin: number;
  /** 慢漂移峰峰值百分比（0.5–3Hz） */
  wowPkPct: number;
  /** 快抖晃 RMS 百分比（6–40Hz） */
  flutterRmsPct: number;
  /** 间隙损耗特征波长 m（缝长量级，典型 1.5–4μm） */
  gapLambdaM: number;
  /** 参考音 Hz，0 = 用 50Hz 哼声作为跟踪源 */
  refHz: number;
  /** 随机种子（可复现） */
  seed: number;
}

export const SCENARIOS: Record<string, ScenarioParams> = {
  /** 轻度：抖晃 0.3%、方位 8 角分 */
  mild: {
    scenario: 'mild', durationSec: 30, sampleRate: 48000,
    azimuthArcmin: 8, wowPkPct: 0.6, flutterRmsPct: 0.3,
    gapLambdaM: 8e-6, refHz: 1000, seed: 20261122,
  },
  /** 重度：抖晃 1.5%、方位 25 角分、高频明显发闷 */
  severe: {
    scenario: 'severe', durationSec: 30, sampleRate: 48000,
    azimuthArcmin: 25, wowPkPct: 2.5, flutterRmsPct: 1.5,
    gapLambdaM: 14e-6, refHz: 1000, seed: 20261123,
  },
  /** 无参考音：仅 50Hz 哼声可锁定；方位角取可可靠观测的 ≥1 样本区间 */
  humOnly: {
    scenario: 'humOnly', durationSec: 30, sampleRate: 48000,
    azimuthArcmin: 16, wowPkPct: 1.2, flutterRmsPct: 0.8,
    gapLambdaM: 8e-6, refHz: 0, seed: 20261124,
  },
};

/** 开盘带 1/4"、19.05cm/s 的默认磁迹参数 */
export const OPEN_REEL_SPEC: Omit<TapeSpec, 'sampleRate' | 'refToneHz' | 'refChannel' | 'humHz'> = {
  trackSpacingM: 1.78e-3,
  tapeSpeed: 0.1905,
};

/** 可复现的确定性 PRNG（mulberry32） */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    this.s |= 0; this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** 高斯噪声（Box–Muller） */
  gaussian(): number {
    const u = Math.max(1e-12, this.next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
}

/**
 * 合成一条"老化机器录出来"的立体声测试带。
 *
 * 处理链（先造干净信号，再依次施加真实缺陷）：
 *  1. 宽带节目素材（粉噪声 + 多频正弦，能量铺满 100Hz–15kHz）
 *  2. 参考音（左声道 -20dB）或 50Hz 哼声（两声道）
 *  3. 变速损伤：s(t)=1+慢漂移+快抖晃，做变速重采样
 *  4. 方位角：右声道分数延迟 + 右声道额外高频滚降
 *  5. 间隙损耗：每通道频域滚降（时域 FFT 卷积实现）
 *  6. 本底磁带噪声
 */
export function synthesizeTestTape(p: ScenarioParams, spec: TapeSpec): {
  stereo: Float32Array;
  groundTruth: SyntheticGroundTruth;
} {
  const n = Math.floor(p.durationSec * p.sampleRate);
  const rng = new Rng(p.seed);

  // ---- 1) 干净节目：粉噪声 + 多频成分 ----
  const program = new Float32Array(n);
  let white = 0;
  for (let i = 0; i < n; i++) {
    const w = rng.gaussian();
    white = 0.95 * white + 0.05 * w; // 一阶低通近似粉噪
    let tones = 0;
    // 中低频分量
    for (const f of [220, 440, 880, 2000]) {
      tones += 0.06 * Math.sin(2 * Math.PI * f * (i / p.sampleRate) + f);
    }
    // 高频线谱加权，为频响测量与逆补偿提供可靠的高频能量锚点
    for (const f of [5000, 8000, 10000, 12000]) {
      tones += 0.12 * Math.sin(2 * Math.PI * f * (i / p.sampleRate) + f);
    }
    program[i] = 0.4 * white + tones;
  }

  // ---- 2) 跟踪源 ----
  const trackL = new Float32Array(n);
  const trackR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    trackL[i] = program[i];
    trackR[i] = program[i] * (0.97 + 0.03 * rng.gaussian());
    if (p.refHz > 0) {
      trackL[i] += 0.1 * Math.sin(2 * Math.PI * p.refHz * (i / p.sampleRate));
    } else {
      const hum = 0.05 * Math.sin(2 * Math.PI * 50 * (i / p.sampleRate))
        + 0.02 * Math.sin(2 * Math.PI * 100 * (i / p.sampleRate));
      trackL[i] += hum;
      trackR[i] += hum * 0.9;
    }
  }

  // ---- 3) 变速损伤 s(t) ----
  const speed = new Float64Array(n);
  const flutterAmp = p.flutterRmsPct / 100;
  const wowAmp = p.wowPkPct / 2 / 100;
  for (let i = 0; i < n; i++) {
    const t = i / p.sampleRate;
    const wow = wowAmp * (
      Math.sin(2 * Math.PI * 0.8 * t + 0.7) +
      0.5 * Math.sin(2 * Math.PI * 2.1 * t)
    );
    const flutter = flutterAmp * (
      0.7 * Math.sin(2 * Math.PI * 12 * t + 1.3) +
      0.5 * Math.sin(2 * Math.PI * 31 * t + 2.4) +
      0.3 * Math.sin(2 * Math.PI * 47 * t)
    );
    speed[i] = 1 + wow + flutter;
  }
  const damagedL = applySpeed(trackL, speed);
  const damagedR = applySpeed(trackR, speed);

  // ---- 4) 方位角：右声道分数延迟 + 右声道附加滚降 ----
  const angleRad = p.azimuthArcmin * RAD_PER_ARCMIN;
  const delay = angleToDelay(angleRad, spec);
  const delayedR = fractionalDelay(damagedR, delay);

  // 方位导致的右声道附加有效缝宽
  const extraLambda = spec.trackSpacingM * Math.sin(angleRad) * 0.15;

  // ---- 5) 间隙损耗（频域 FFT 卷积）----
  const outL = applyGapLoss(damagedL, p.sampleRate, p.gapLambdaM, spec.tapeSpeed, rng);
  const outR = applyGapLoss(delayedR, p.sampleRate, p.gapLambdaM + extraLambda, spec.tapeSpeed, rng);

  // ---- 6) 磁带本底噪声 ----
  for (let i = 0; i < n; i++) {
    outL[i] += 0.004 * rng.gaussian();
    outR[i] += 0.004 * rng.gaussian();
  }

  const stereo = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    stereo[2 * i] = clamp(outL[i]);
    stereo[2 * i + 1] = clamp(outR[i]);
  }

  return {
    stereo,
    groundTruth: {
      scenario: p.scenario,
      azimuthArcmin: p.azimuthArcmin,
      flutterRmsPct: p.flutterRmsPct,
      wowPkPct: p.wowPkPct,
      gapLambdaM: p.gapLambdaM,
      refHz: p.refHz,
    },
  };
}

/** 按给定速度曲线对信号做变速重采样（输出长度与输入相同，末端零填） */
function applySpeed(input: Float32Array, speed: Float64Array): Float32Array {
  const out = new Float32Array(input.length);
  let pos = 0;
  for (let i = 0; i < input.length; i++) {
    const idx = Math.floor(pos);
    const frac = pos - idx;
    if (idx + 2 < input.length) {
      out[i] = catmullRom(
        input[Math.max(0, idx - 1)], input[idx], input[idx + 1], input[idx + 2], frac,
      );
    }
    pos += speed[Math.min(input.length - 1, idx)];
  }
  return out;
}

/** 正分数延迟（与修复端同阶插值，保证合成/修复模型一致） */
function fractionalDelay(input: Float32Array, delay: number): Float32Array {
  const out = new Float32Array(input.length);
  const base = Math.floor(delay);
  const frac = delay - base;
  for (let i = 0; i < input.length; i++) {
    const i0 = i - base;
    out[i] = catmullRom(
      input[Math.max(0, i0 - 1)] ?? 0,
      input[Math.max(0, i0)] ?? 0,
      input[i0 + 1] ?? 0,
      input[i0 + 2] ?? 0,
      frac,
    );
  }
  return out;
}

/** 用 FFT 构造间隙损耗 FIR 并卷积（分段，避免超大 FFT） */
function applyGapLoss(
  input: Float32Array, sampleRate: number, lambdaM: number, tapeSpeed: number, rng: Rng,
): Float32Array {
  const firLen = 127;
  const half = firLen >> 1;
  const nfft = 512;
  // 在 FFT 网格上采样目标幅度，IDFT 得到零相位 FIR
  const mag = new Float64Array(nfft / 2 + 1);
  for (let k = 0; k <= nfft / 2; k++) {
    const f = (k * sampleRate) / nfft;
    mag[k] = gapLossResponse([f], sampleRate, lambdaM, tapeSpeed)[0];
  }
  const full = new Float64Array(nfft);
  for (let k = 0; k <= nfft / 2; k++) full[k] = mag[k];
  for (let k = 1; k < nfft / 2; k++) full[nfft - k] = mag[k];
  const fir = new Float64Array(firLen);
  for (let n = 0; n < firLen; n++) {
    const m = n - half;
    let s = 0;
    for (let k = 0; k < nfft; k++) s += full[k] * Math.cos((2 * Math.PI * k * m) / nfft);
    fir[n] = s / nfft;
  }
  // 目标响应是平滑的 sinc 滚降（无尖锐过渡），用温和的 Hann 平方根窗
  // 抑制截断振铃，同时避免普通 Hann 窗过度展宽主瓣导致频响失真。
  const win = hannWindow(firLen);
  for (let n = 0; n < firLen; n++) fir[n] *= Math.sqrt(win[n]);
  // 直接卷积（firLen=127，测试带规模可接受）
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = 0;
    for (let j = 0; j < firLen; j++) {
      const idx = i + j - half;
      if (idx >= 0 && idx < input.length) s += fir[j] * input[idx];
    }
    out[i] = s;
  }
  void rng;
  return out;
}

function clamp(x: number): number {
  return Math.max(-1, Math.min(1, x));
}
