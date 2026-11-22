/** 全项目共享的 DSP 数据结构（主线程与 Worklet 之间通过 structuredClone 传递） */

/** 一盘磁带的物理/登记参数 */
export interface TapeSpec {
  /** 左右声道磁迹中心间距，米（开盘 1/4" 约 1.78mm，盒式带约 0.5mm） */
  trackSpacingM: number;
  /** 走带速度，m/s（开盘 19.05cm/s 或 9.53cm/s；盒式 4.76cm/s） */
  tapeSpeed: number;
  /** 参考音频率 Hz（常见 1kHz / 3kHz），0 表示无参考音、改用交流哼声 */
  refToneHz: number;
  /** 参考音所在声道（-1 = 混合成单声道检测） */
  refChannel: number;
  /** 哼声频率 50 或 60，参考音缺失时启用 */
  humHz: number;
  sampleRate: number;
}

/** 抖晃跟踪块级结果（每个分析块一条） */
export interface DriftPoint {
  /** 块中心对应的输入时间，秒 */
  t: number;
  /** 瞬时播放比 s = 实际走带速度 / 额定速度（1 为正常） */
  ratio: number;
  /** 该块参考信号能量，用于门限判断 */
  level: number;
  /** 估计可信度 0..1（相干度） */
  coherence: number;
}

export interface WowFlutterReport {
  /** 完整平滑后的速度比曲线（块级） */
  curve: DriftPoint[];
  /** 加权抖晃率（峰峰值百分比，DIN/IEC 风格的简化实现） */
  wowFlutterPct: number;
  /** 0.5–6 Hz 慢漂移 RMS（百分比） */
  wowRmsPct: number;
  /** 6–60 Hz 抖晃 RMS（百分比） */
  flutterRmsPct: number;
  /** 检测到的跟踪源描述 */
  source: string;
}

/** 方位角估计结果 */
export interface AzimuthResult {
  /** L 相对 R 的分数延迟（样本，正=左滞后） */
  delaySamples: number;
  /** 方位角偏差，弧度 */
  angleRad: number;
  /** 方位角偏差，角分（1 度 = 60 分） */
  angleArcmin: number;
  /** GCC-PHAT 峰值相干度 0..1 */
  coherence: number;
  /** 逐帧估计（样本），用于诊断散布 */
  perFrame: number[];
}

/** 间隙损耗/高频均衡设计结果 */
export interface EqDesign {
  /** 线性相位 FIR 系数（零相位形式，长度奇数） */
  fir: Float32Array;
  /** 设计频点 Hz */
  freqs: Float32Array;
  /** 目标幅度响应（线性） */
  targetGain: Float32Array;
  /** 补偿前实测幅度响应（线性） */
  measuredGain: Float32Array;
  /** 10kHz 处补偿后相对参考带的残差 dB */
  residualAt10kDb: number;
  /** 通道间对齐分数延迟（样本） */
  alignDelay: number;
}

export interface RestoreResult {
  /** 修复后的立体声音频（平面存储 LRLR…，按输出采样率） */
  audio: Float32Array;
  sampleRate: number;
  drift: WowFlutterReport;
  azimuth: AzimuthResult;
  eq: EqDesign[];
  /** 处理耗时 ms */
  elapsedMs: number;
  /** 实时倍率（音频时长 / 处理时长） */
  realtimeFactor: number;
}

/** 合成测试带的真值（供验收测试比对） */
export interface SyntheticGroundTruth {
  scenario: string;
  /** 注入的方位角（角分） */
  azimuthArcmin: number;
  /** 注入的抖晃 RMS（百分比） */
  flutterRmsPct: number;
  /** 注入的慢漂移峰峰值（百分比） */
  wowPkPct: number;
  /** 注入的间隙损耗波长 m（越小高频越暗） */
  gapLambdaM: number;
  /** 参考音/哼声频率 */
  refHz: number;
}

export const ARCSEC_PER_RAD = 206264.806;
export const ARCMIN_PER_RAD = ARCSEC_PER_RAD / 60;
export const RAD_PER_ARCMIN = 1 / ARCMIN_PER_RAD;
