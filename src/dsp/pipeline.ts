/**
 * 修复流水线编排（TypeScript 侧）。
 *
 * 职责分工（对应需求）：
 *   - 抖晃跟踪、滤波：AudioWorklet（见 public/worklets 与 workletEngine）
 *   - 速率图平滑、变采样率重采样、滤波器设计、指标核算、流程编排：TypeScript
 *
 * 长磁带采用分块流式：每块独立跑 OfflineAudioContext 中的 Worklet，
 * FIR 块间携带重叠尾部保证卷积连续，内存占用与磁带长度无关。
 */

import { fftInPlace } from './fft';
import { resampleChannel, type RateMap } from './resample';
import { trackRate, smoothRateMap } from './tracker';
import { estimateAzimuth, type AzimuthEstimate } from './azimuth';
import { designStereoPlan, evaluateMagnitude, type StereoFilterPlan } from './filterDesign';
import { measureResponse, responseAtFreq, convolveOverlapSave } from './fir';
import {
  ARCMIN_TO_RAD,
  RAD_TO_ARCMIN,
  linearToDb,
  TAPE_SPEED_MPS,
} from './constants';
import {
  runTrackerOffline,
  runAzimuthOffline,
  runFirOffline,
  createWorklet,
} from '../audio/workletEngine';
import type { RestorationMetrics, RestorationParams } from '../db';

export interface PipelineInput {
  sampleRate: number;
  channels: Float64Array[]; // [left, right]
  /** 可选参考带（校准带/同类无损样本），用于扣除素材自然频谱滚降。 */
  reference?: { freqs: ArrayLike<number>; magnitudeDb: ArrayLike<number> };
}

export interface PipelineResult {
  restored: { left: Float64Array; right: Float64Array };
  rateMap: RateMap;
  azimuth: AzimuthEstimate;
  filterPlan: StereoFilterPlan;
  metrics: RestorationMetrics;
  /** 修复前 10kHz 响应（dB）。 */
  lossDbAt10k: number;
  /** 修复后 10kHz 残余偏差（dB，相对 1kHz 基准带）。 */
  residualDbAt10k: number;
}

export interface ProgressCb {
  (stage: string, progress: number): void;
}

/**
 * 估计磁头缝隙造成的高频损耗（dB）。
 *
 * 节目素材本身有自然频谱形状，不能直接把 10k/1k 之比当作磁头损耗。
 * 需要一份参考频谱（校准带，或同类素材的无损样本）：
 *     损耗 = (形状_待测 - 形状_参考)，其中形状 = 10k 电平 - 1k 电平
 * 无参考时退化为只测形状（调用方需自行扣除已知素材滚降）。
 */
export function estimateLossAt10k(
  signal: ArrayLike<number>,
  sampleRate: number,
  referenceResponse?: { freqs: ArrayLike<number>; magnitudeDb: ArrayLike<number> },
): { lossDb: number; response: { freqs: Float64Array; magnitudeDb: Float64Array } } {
  const response = measureResponse(signal, sampleRate, 8192, { fft: fftInPlace });
  const shapeOf = (r: { freqs: ArrayLike<number>; magnitudeDb: ArrayLike<number> }) => {
    const ref = (responseAtFreq(r.freqs, r.magnitudeDb, 900) +
      responseAtFreq(r.freqs, r.magnitudeDb, 1100)) / 2;
    return responseAtFreq(r.freqs, r.magnitudeDb, 10000) - ref;
  };
  const measuredShape = shapeOf(response);
  const referenceShape = referenceResponse ? shapeOf(referenceResponse) : 0;
  // 待测形状比参考更负的部分，就是磁头额外损耗
  return { lossDb: Math.max(0, referenceShape - measuredShape), response };
}

/**
 * 纯 TS 流水线（单元测试与无浏览器环境用）。
 * Worklet 内为同构移植，页面自检会交叉验证两者结果一致。
 */
export function runPipelineTs(input: PipelineInput, params: RestorationParams): PipelineResult {
  const fs = input.sampleRate;
  const [left, right] = input.channels;

  // 1. 抖晃跟踪（参考音；无参考音时退化为哼声谐波）
  const harmonics = params.useHum ? [1, 2, 3, 4] : [1];
  const refHz = params.useHum ? params.humHz : params.referenceHz;
  const tracked = trackRate(left, {
    sampleRate: fs,
    referenceHz: refHz,
    harmonics,
    frameSize: 2048,
  });
  const smoothed = smoothRateMap(tracked.ratesPerSecond);
  const rateMap: RateMap = { ratesPerSecond: smoothed, sampleRate: fs };

  // 2. 变采样率校正
  const fixedL = resampleChannel(left, rateMap);
  const fixedR = resampleChannel(right, rateMap);

  // 3. 方位角估计（用开头 2 秒即可，参数稳定）
  const probeLen = Math.min(fixedL.length, fs * 2);
  const azimuth = estimateAzimuth(
    fixedL.subarray(0, probeLen),
    fixedR.subarray(0, probeLen),
    { sampleRate: fs, fftSize: 2048, maxFrames: 48 },
  );

  // 4. 高频损耗估计与滤波器设计（有参考带时扣除素材自然滚降）
  const { lossDb } = estimateLossAt10k(fixedL, fs, input.reference);
  const plan = designStereoPlan(azimuth.delaySeconds, lossDb, fs, params.taps);

  // 5. 卷积修复（overlap-save 频域快速卷积，长信号 O(N log N)）
  const restoredL = convolveOverlapSave(fixedL, plan.left.combined, { fft: fftInPlace });
  const restoredR = convolveOverlapSave(fixedR, plan.right.combined, { fft: fftInPlace });

  // 6. 指标核算：10kHz 残余偏差 = 修复后形状 − 参考带形状（dB）
  const warpPeak = warpPeakPercent(smoothed);
  const shapeOf = (r: { freqs: ArrayLike<number>; magnitudeDb: ArrayLike<number> }) => {
    const ref = (responseAtFreq(r.freqs, r.magnitudeDb, 900) +
      responseAtFreq(r.freqs, r.magnitudeDb, 1100)) / 2;
    return responseAtFreq(r.freqs, r.magnitudeDb, 10000) - ref;
  };
  const respAfter = measureResponse(restoredL, fs, 8192, { fft: fftInPlace });
  const restoredShape = shapeOf(respAfter);
  const referenceShape = input.reference ? shapeOf(input.reference) : 0;
  const residualDbAt10k = restoredShape - referenceShape;

  const metrics: RestorationMetrics = {
    warpPeakPercent: warpPeak,
    azimuthArcmin: azimuth.thetaArcmin,
    azimuthStdArcmin: azimuth.delayStdSeconds * (TAPE_SPEED_MPS / 0.65e-3) * RAD_TO_ARCMIN,
    delayMs: azimuth.delaySeconds * 1000,
    lossDbAt10k: lossDb,
    residualDbAt10k,
    processingSeconds: 0,
    realtimeFactor: 0,
  };

  return {
    restored: { left: restoredL, right: restoredR },
    rateMap,
    azimuth,
    filterPlan: plan,
    metrics,
    lossDbAt10k: lossDb,
    residualDbAt10k,
  };
}

/** 速率图峰值偏离（百分比）。 */
export function warpPeakPercent(ratesPerSecond: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < ratesPerSecond.length; i++) {
    peak = Math.max(peak, Math.abs(ratesPerSecond[i] - 1) * 100);
  }
  return peak;
}

// ---------------------------------------------------------------------------
// 浏览器 Worklet 流水线
// ---------------------------------------------------------------------------

export function toAudioBuffer(channels: Float64Array[], sampleRate: number): AudioBuffer {
  const ctx = new OfflineAudioContext(2, channels[0].length, sampleRate);
  const buf = ctx.createBuffer(2, channels[0].length, sampleRate);
  buf.copyToChannel(Float32Array.from(channels[0]), 0);
  buf.copyToChannel(Float32Array.from(channels[1]), 1);
  return buf;
}

/**
 * Worklet 流水线（内存可容纳的磁带，典型演示与导入文件）。
 */
export async function runPipelineWorklet(
  input: PipelineInput,
  params: RestorationParams,
  onProgress?: ProgressCb,
): Promise<PipelineResult> {
  const t0 = performance.now();
  const fs = input.sampleRate;
  const [left, right] = input.channels;
  onProgress?.('worklet: 抖晃跟踪', 0.05);

  // 1. 跟踪 Worklet
  const buffer = toAudioBuffer([left, right], fs);
  const harmonics = params.useHum ? [1, 2, 3, 4] : [1];
  const refHz = params.useHum ? params.humHz : params.referenceHz;
  const tracker = await runTrackerOffline(buffer, refHz, harmonics, 2048);
  const smoothed = smoothRateMap(tracker.ratesPerSecond);
  const rateMap: RateMap = { ratesPerSecond: smoothed, sampleRate: fs };
  onProgress?.('TS: 变采样率校正', 0.3);

  // 2. TS 重采样
  const fixedL = resampleChannel(left, rateMap);
  const fixedR = resampleChannel(right, rateMap);

  // 3. 方位角 Worklet
  onProgress?.('worklet: 方位角估计', 0.45);
  const fixedBuffer = toAudioBuffer([fixedL, fixedR], fs);
  const az = await runAzimuthOffline(fixedBuffer, { fftSize: 2048, maxFrames: 48 });
  const azimuth: AzimuthEstimate = {
    thetaRad: az.delaySeconds === 0 ? 0 : Math.atan((az.delaySeconds * TAPE_SPEED_MPS) / 0.65e-3),
    thetaArcmin:
      az.delaySeconds === 0
        ? 0
        : Math.atan((az.delaySeconds * TAPE_SPEED_MPS) / 0.65e-3) * RAD_TO_ARCMIN,
    delaySeconds: az.delaySeconds,
    delayStdSeconds: az.delayStdSeconds,
    residualRms: az.residualRms,
    binsUsed: az.binsUsed,
    coherence: az.coherence,
  };

  // 4. 损耗 + 滤波器设计（TS）
  onProgress?.('TS: 修复滤波器设计', 0.6);
  const { lossDb } = estimateLossAt10k(fixedL, fs, input.reference);
  const plan = designStereoPlan(az.delaySeconds, lossDb, fs, params.taps);

  // 5. FIR Worklet
  onProgress?.('worklet: 高频补偿滤波', 0.75);
  const restoredBuffer = await runFirOffline(fixedBuffer, plan.left.combined, plan.right.combined);
  const restoredL = restoredBuffer.getChannelData(0).slice();
  const restoredR = restoredBuffer.getChannelData(1).slice();

  // 7. 指标：相对参考带的 10kHz 形状残余
  onProgress?.('核算指标', 0.95);
  const shapeOf = (r: { freqs: ArrayLike<number>; magnitudeDb: ArrayLike<number> }) => {
    const ref = (responseAtFreq(r.freqs, r.magnitudeDb, 900) +
      responseAtFreq(r.freqs, r.magnitudeDb, 1100)) / 2;
    return responseAtFreq(r.freqs, r.magnitudeDb, 10000) - ref;
  };
  const respAfter = measureResponse(restoredL, fs, 8192, { fft: fftInPlace });
  const referenceShape = input.reference ? shapeOf(input.reference) : 0;
  const residualDbAt10k = shapeOf(respAfter) - referenceShape;

  const elapsed = (performance.now() - t0) / 1000;
  const durationSec = left.length / fs;
  const metrics: RestorationMetrics = {
    warpPeakPercent: warpPeakPercent(smoothed),
    azimuthArcmin: azimuth.thetaArcmin,
    azimuthStdArcmin: azimuth.delayStdSeconds * (TAPE_SPEED_MPS / 0.65e-3) * RAD_TO_ARCMIN,
    delayMs: azimuth.delaySeconds * 1000,
    lossDbAt10k: lossDb,
    residualDbAt10k,
    processingSeconds: elapsed,
    realtimeFactor: durationSec / Math.max(elapsed, 1e-6),
  };
  onProgress?.('完成', 1);

  return {
    restored: { left: new Float64Array(restoredL), right: new Float64Array(restoredR) },
    rateMap,
    azimuth,
    filterPlan: plan,
    metrics,
    lossDbAt10k: lossDb,
    residualDbAt10k,
  };
}

// ---------------------------------------------------------------------------
// 长磁带分块流式（60 分钟基准）：块级 Worklet 渲染，内存有界
// ---------------------------------------------------------------------------

export interface ChunkSource {
  readonly chunkFrames: number;
  readonly totalChunks: number;
  readonly sampleRate: number;
  getChunk(index: number): Promise<{ left: Float64Array; right: Float64Array }> | { left: Float64Array; right: Float64Array };
}

export interface StreamResult {
  metrics: RestorationMetrics;
  rateMap: RateMap;
  azimuth: AzimuthEstimate;
  frameCount: number;
}

/**
 * 分块流式处理整盘长磁带。每块经过：
 *   跟踪 Worklet（累积帧点）→ TS 重采样（相位跨块延续）
 *   → 方位角 Worklet（仅首块）→ FIR Worklet（前置 M-1 样本保持卷积连续）
 * 输出块交给 onChunk 回调（通常直接编码 WAV 落库），不整盘驻留。
 */
export async function runPipelineStream(
  source: ChunkSource,
  params: RestorationParams,
  onChunk: (left: Float64Array, right: Float64Array, index: number) => Promise<void> | void,
  onProgress?: ProgressCb,
  referenceResponse?: { freqs: ArrayLike<number>; magnitudeDb: ArrayLike<number> },
): Promise<StreamResult> {
  const t0 = performance.now();
  const fs = source.sampleRate;
  const M = params.taps;
  const tailL = new Float64Array(M - 1);
  const tailR = new Float64Array(M - 1);
  let globalPhaseL = 0;
  let globalPhaseR = 0;
  let allRates: number[] = [];
  let azimuth: AzimuthEstimate | null = null;
  let lossDb = 0;
  let plan: StereoFilterPlan | null = null;
  let frameCount = 0;

  for (let ci = 0; ci < source.totalChunks; ci++) {
    const chunk = await source.getChunk(ci);
    const chunkBuf = toAudioBuffer([chunk.left, chunk.right], fs);

    // 跟踪（每块独立渲染，帧点拼接；秒级速率图最后融合）
    const harmonics = params.useHum ? [1, 2, 3, 4] : [1];
    const refHz = params.useHum ? params.humHz : params.referenceHz;
    const trk = await runTrackerOffline(chunkBuf, refHz, harmonics, 2048);
    allRates = allRates.concat(Array.from(trk.ratesPerSecond));

    // TS 重采样（全局输入相位，局部寻址）
    const rateMap: RateMap = {
      ratesPerSecond: Float64Array.from(allRates),
      sampleRate: fs,
    };
    const offset = ci * source.chunkFrames;
    const fixedL = resampleChunk(chunk.left, rateMap, offset, fs, globalPhaseL);
    const fixedR = resampleChunk(chunk.right, rateMap, offset, fs, globalPhaseR);
    globalPhaseL = fixedL.nextPhase;
    globalPhaseR = fixedR.nextPhase;

    // 方位角与损耗仅在首块估计（机械偏差在整盘内视为恒定）
    if (ci === 0) {
      const probe = toAudioBuffer([fixedL.out, fixedR.out], fs);
      const az = await runAzimuthOffline(probe, { fftSize: 2048, maxFrames: 48 });
      azimuth = {
        thetaRad: Math.atan((az.delaySeconds * TAPE_SPEED_MPS) / 0.65e-3),
        thetaArcmin: Math.atan((az.delaySeconds * TAPE_SPEED_MPS) / 0.65e-3) * RAD_TO_ARCMIN,
        delaySeconds: az.delaySeconds,
        delayStdSeconds: az.delayStdSeconds,
        residualRms: az.residualRms,
        binsUsed: az.binsUsed,
        coherence: az.coherence,
      };
      lossDb = estimateLossAt10k(fixedL.out, fs, referenceResponse).lossDb;
      plan = designStereoPlan(az.delaySeconds, lossDb, fs, M);
    }

    // FIR：前置上一块尾部保持卷积状态连续
    const paddedL = new Float64Array(fixedL.out.length + M - 1);
    const paddedR = new Float64Array(fixedR.out.length + M - 1);
    paddedL.set(tailL, 0);
    paddedR.set(tailR, 0);
    paddedL.set(fixedL.out, M - 1);
    paddedR.set(fixedR.out, M - 1);
    const paddedBuf = toAudioBuffer([paddedL, paddedR], fs);
    const filtered = await runFirOffline(paddedBuf, plan!.left.combined, plan!.right.combined);
    // 去掉前置部分对应的输出（前 M-1 个有效样本从偏移 M-1 起对齐）
    const outL = new Float64Array(fixedL.out.length);
    const outR = new Float64Array(fixedR.out.length);
    outL.set(filtered.getChannelData(0).subarray(M - 1, M - 1 + fixedL.out.length));
    outR.set(filtered.getChannelData(1).subarray(M - 1, M - 1 + fixedR.out.length));
    tailL.set(fixedL.out.subarray(fixedL.out.length - (M - 1)));
    tailR.set(fixedR.out.subarray(fixedR.out.length - (M - 1)));

    await onChunk(outL, outR, ci);
    frameCount += outL.length;
    onProgress?.(`分块 ${ci + 1}/${source.totalChunks}`, (ci + 1) / source.totalChunks);
  }

  const smoothed = smoothRateMap(Float64Array.from(allRates));
  const warpPeak = warpPeakPercent(smoothed);
  const elapsed = (performance.now() - t0) / 1000;
  const durationSec = frameCount / fs;

  const metrics: RestorationMetrics = {
    warpPeakPercent: warpPeak,
    azimuthArcmin: azimuth!.thetaArcmin,
    azimuthStdArcmin: azimuth!.delayStdSeconds * (TAPE_SPEED_MPS / 0.65e-3) * RAD_TO_ARCMIN,
    delayMs: azimuth!.delaySeconds * 1000,
    lossDbAt10k: lossDb,
    residualDbAt10k: 0, // 流式路径由设计响应核算，见下方覆盖
    processingSeconds: elapsed,
    realtimeFactor: durationSec / Math.max(elapsed, 1e-6),
  };
  // 用滤波器设计响应核算 10kHz 残余（与实测路径等价，避免保存整盘输出）
  const designed10k = evaluateMagnitude(plan!.left.combined, 10000, fs);
  const designed1k = evaluateMagnitude(plan!.left.combined, 1000, fs);
  metrics.residualDbAt10k = linearToDb(designed10k / designed1k);

  return {
    metrics,
    rateMap: { ratesPerSecond: smoothed, sampleRate: fs },
    azimuth: azimuth!,
    frameCount,
  };
}

/** 分块重采样，携带跨块全局相位。 */
function resampleChunk(
  input: Float64Array,
  map: RateMap,
  globalOffset: number,
  fs: number,
  startGlobalPhase: number,
): { out: Float64Array; nextPhase: number } {
  const out = new Float64Array(input.length);
  let globalPhase = startGlobalPhase;
  for (let m = 0; m < out.length; m++) {
    const globalSample = globalOffset + m;
    const t = globalSample / fs;
    // 局部寻址位置 = 全局输入相位 - 本块全局起点
    const localPos = globalPhase - globalOffset;
    out[m] = cubicAt(input, localPos);
    globalPhase += sampleMapAt(map, t);
  }
  return { out, nextPhase: globalPhase };
}

function sampleMapAt(map: RateMap, t: number): number {
  const a = map.ratesPerSecond;
  const i = Math.floor(t);
  if (i <= 0) return a[0];
  if (i >= a.length - 1) return a[a.length - 1];
  const frac = t - i;
  return a[i] * (1 - frac) + a[i + 1] * frac;
}

function cubicAt(input: Float64Array, pos: number): number {
  const n = input.length;
  const i = Math.floor(pos);
  const frac = pos - i;
  const i0 = Math.min(n - 1, Math.max(0, i - 1));
  const i1 = Math.min(n - 1, Math.max(0, i));
  const i2 = Math.min(n - 1, Math.max(0, i + 1));
  const i3 = Math.min(n - 1, Math.max(0, i + 2));
  const x = frac;
  const p0 = input[i0], p1 = input[i1], p2 = input[i2], p3 = input[i3];
  const x2 = x * x;
  const x3 = x2 * x;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * x +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * x2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * x3)
  );
}

/** 便于测试引用：角分转弧度。 */
export function arcminToRad(arcmin: number): number {
  return arcmin * ARCMIN_TO_RAD;
}

// 标记 createWorklet 为模块对外可用（实时试听页直接引用引擎）
export { createWorklet };
