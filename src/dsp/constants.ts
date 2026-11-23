/**
 * 磁带-磁头物理常量与全局约定。
 *
 * 方位角（azimuth）几何：磁头缝隙与磁迹法线之间有偏角 θ 时，左右两条磁迹
 * （垂直间距 trackPitch）读到的同一场点存在时间差
 *
 *     τ(θ) = trackPitch · tan(θ) / tapeSpeed
 *
 * 该关系在合成（测试带）和估计（实测带）两侧共用，保证自洽。
 * 角度统一使用弧度；界面与测试中用角分（1° = 60 角分）展示。
 */

export const ARCMIN_TO_RAD = Math.PI / (180 * 60);
export const RAD_TO_ARCMIN = (180 * 60) / Math.PI;

/** 磁头两条立体声音轨的垂直间距，米（紧凑盒式带约 0.65 mm）。 */
export const TRACK_PITCH_M = 0.65e-3;

/** 带速，米/秒（紧凑盒式带标准 4.76 cm/s）。 */
export const TAPE_SPEED_MPS = 0.0476;

/** 默认采样率。 */
export const DEFAULT_SAMPLE_RATE = 48000;

/**
 * 方位角偏差对应的左右声道延迟（秒）。
 * θ 为磁头方位角偏差（弧度），正值表示右声道晚于左声道。
 */
export function azimuthToDelaySeconds(thetaRad: number): number {
  return (TRACK_PITCH_M * Math.tan(thetaRad)) / TAPE_SPEED_MPS;
}

/** 由测得的声道延迟反推方位角偏差（弧度）。 */
export function delaySecondsToAzimuth(delaySeconds: number): number {
  return Math.atan((delaySeconds * TAPE_SPEED_MPS) / TRACK_PITCH_M);
}

/**
 * 缝隙损耗（gap loss）：磁头缝隙有限宽度对高频的梳状衰减，
 * 这是“高频发闷”的主因。归一化频率 x = π · g · f / v。
 * 返回线性幅度比（≤1）。
 */
export function gapLossLinear(freqHz: number, gapM: number, tapeSpeedMps: number): number {
  const x = (Math.PI * gapM * freqHz) / tapeSpeedMps;
  if (x < 1e-9) return 1;
  return Math.abs(Math.sin(x) / x);
}

/**
 * 给定 10 kHz 处目标衰减量（dB，正数表示衰减多少），反解等效缝隙宽度（米）。
 * 合成测试带时用它把“10kHz 衰减 N dB”翻译成物理缝隙参数。
 */
export function gapWidthFromLossAt10k(lossDbAt10k: number): number {
  // sin(x)/x = 10^(-dB/20)，在工作区间 x∈(0, π) 单调，牛顿迭代求解。
  const target = Math.pow(10, -lossDbAt10k / 20);
  let x = Math.sqrt(6 * (1 - target)); // sin(x)/x ≈ 1 - x²/6 的初值
  for (let i = 0; i < 40; i++) {
    const f = Math.sin(x) / x - target;
    const fp = (x * Math.cos(x) - Math.sin(x)) / (x * x);
    const step = f / fp;
    x -= step;
    if (Math.abs(step) < 1e-12) break;
  }
  const gap = (x * TAPE_SPEED_MPS) / (Math.PI * 10000);
  return gap;
}

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export function linearToDb(lin: number): number {
  return 20 * Math.log10(Math.max(lin, 1e-12));
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
