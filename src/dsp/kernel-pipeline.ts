import { buildCorrectionCurve, summarizeWowFlutter, WowFlutterTracker } from './wow-flutter';
import { VariableRateResampler, FractionalDelay } from './resampler';
import { estimateAzimuth } from './azimuth';
import { BiquadNotch, designInverseEq, FirFilter, measureResponse } from './eq-design';
import { detectReferenceOrHum } from './detect-tone';
import type { AzimuthResult, DriftPoint, EqDesign, TapeSpec, WowFlutterReport } from './types';

export interface KernelPipelineResult {
  outL: Float32Array;
  outR: Float32Array;
  drift: WowFlutterReport;
  azimuth: AzimuthResult;
  eq: EqDesign[];
  trackHz: number;
  trackSource: string;
  elapsedMs: number;
}

/**
 * 纯 TS 内核版完整修复管线。
 * 与浏览器 AudioWorklet 使用完全相同的 DSP 类与参数顺序：
 *   跟踪(IQ) → 校正曲线 → 方位(GCC-PHAT) → 逆补偿 FIR 设计
 *   → 逐通道：变速重采样 → 分数延迟 → FIR → 陷波
 */
export function runKernelPipeline(
  chL: Float32Array,
  chR: Float32Array,
  spec: TapeSpec,
  opts: { forceTrackHz?: number; blockSize?: number; notchHz?: number[] } = {},
): KernelPipelineResult {
  const t0 = nowMs();
  const sr = spec.sampleRate;
  const n = Math.min(chL.length, chR.length);

  // 1) 跟踪源
  const headLen = Math.min(n, sr * 10);
  const head = new Float32Array(headLen);
  for (let i = 0; i < headLen; i++) head[i] = 0.5 * (chL[i] + chR[i]);
  const detected = detectReferenceOrHum(head, sr, spec.refToneHz || 1000);
  const trackHz = opts.forceTrackHz ?? detected?.frequency ?? spec.humHz;
  const trackSource = opts.forceTrackHz
    ? `手动 ${opts.forceTrackHz}Hz`
    : detected
      ? `${detected.kind === 'hum' ? '哼声' : '参考音'} ${detected.frequency.toFixed(1)}Hz`
      : `回退哼声 ${spec.humHz}Hz`;

  // 2) DFT 锁相跟踪 + 校正曲线（256 样本块：块率 187.5Hz，完整覆盖 60Hz 抖晃）
  const tracker = new WowFlutterTracker(sr, trackHz, opts.blockSize ?? 256);
  const raw: DriftPoint[] = [];
  for (let i = 0; i < n; i++) {
    const p = tracker.process(0.5 * (chL[i] + chR[i]));
    if (p) raw.push(p);
  }
  const curve = buildCorrectionCurve(raw);
  const drift = summarizeWowFlutter(curve, trackSource);

  // 3) 方位角
  const azimuth = estimateAzimuth(chL.subarray(0, n), chR.subarray(0, n), spec);

  // 4) 频响测量 + 逆补偿 FIR。间隙损耗是磁头/磁带的共模特性，两通道
  // 频响高度一致，只测量 L 通道并复用，省去一次大 FFT 多帧平均。
  // 频响是平稳特性，只取前 10s 测量即可，避免对全长信号做密集 FFT。
  const eq: EqDesign[] = [];
  const analyzeLen = Math.min(n, 10 * sr);
  const { freqs, gain } = measureResponse(chL.subarray(0, analyzeLen), sr);
  const d = designInverseEq(Float64Array.from(freqs), Float64Array.from(gain), sr);
  for (let c = 0; c < 2; c++) {
    eq.push({
      fir: d.fir, freqs: d.freqs, targetGain: d.targetGain,
      measuredGain: d.measuredGain, residualAt10kDb: d.residualAt10kDb, alignDelay: 0,
    });
  }

  // 5) 逐通道修复链
  const halfDelay = azimuth.delaySamples / 2;
  const dL = new FractionalDelay(Math.max(0, halfDelay));
  const dR = new FractionalDelay(Math.max(0, -halfDelay));
  const firL = new FirFilter(eq[0].fir);
  const firR = new FirFilter(eq[1].fir);
  const notchHz = opts.notchHz
    ?? (trackSource.startsWith('哼声') ? [spec.humHz, spec.humHz * 2] : []);
  const notchesL = notchHz.map(f => new BiquadNotch(f, 20, sr));
  const notchesR = notchHz.map(f => new BiquadNotch(f, 20, sr));

  const resL = new VariableRateResampler(sr, curve);
  const resR = new VariableRateResampler(sr, curve);
  // 末端补零冲洗滤波器群延迟
  const pad = 512;
  const inL = padInput(chL, n, pad);
  const inR = padInput(chR, n, pad);
  const aL = resL.process(inL);
  const aR = resR.process(inR);
  const len = Math.min(aL.length, aR.length);
  const outL = new Float32Array(len);
  const outR = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let xL = dL.process(aL[i]);
    let xR = dR.process(aR[i]);
    xL = firL.process(xL);
    xR = firR.process(xR);
    for (const nz of notchesL) xL = nz.process(xL);
    for (const nz of notchesR) xR = nz.process(xR);
    outL[i] = xL;
    outR[i] = xR;
  }

  return {
    outL, outR, drift, azimuth, eq, trackHz, trackSource,
    elapsedMs: nowMs() - t0,
  };
}

function padInput(ch: Float32Array, n: number, pad: number): Float32Array {
  const out = new Float32Array(n + pad);
  out.set(ch.subarray(0, n), 0);
  return out;
}

function nowMs(): number {
  // 同时兼容 Node(performance) 与浏览器
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
