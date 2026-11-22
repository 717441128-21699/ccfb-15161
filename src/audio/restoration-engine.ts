import type { AzimuthResult, DriftPoint, EqDesign, TapeSpec, WowFlutterReport } from '../dsp/types';
import { buildCorrectionCurve, summarizeWowFlutter, WowFlutterTracker } from '../dsp/wow-flutter';
import { estimateAzimuth } from '../dsp/azimuth';
import { designInverseEq, measureResponse } from '../dsp/eq-design';
import { detectReferenceOrHum } from '../dsp/detect-tone';

/** Worklet 在 Vite 插件下的虚拟模块 URL（dev 走中间件，build 走打包产物） */
export const TRACKER_WORKLET_URL = new URL('../worklets/wow-flutter-tracker.worklet.ts', import.meta.url);
export const RESTORATION_WORKLET_URL = new URL('../worklets/restoration.worklet.ts', import.meta.url);

export interface EngineProgress {
  phase: 'detect' | 'tracking' | 'azimuth' | 'eq' | 'restoring' | 'done';
  /** 0..1 */
  fraction: number;
  message: string;
}

export interface EngineInput {
  /** 平面立体声 Float32（LRLR…）或两个独立声道 */
  channels: [Float32Array, Float32Array];
  sampleRate: number;
  spec: TapeSpec;
  /** 手动指定跟踪频率；不给则自动检测参考音/哼声 */
  forceTrackHz?: number;
  onProgress?: (p: EngineProgress) => void;
  /** 分块秒数，控制内存峰值 */
  chunkSec?: number;
  /** 哼声陷波频率（检测到 hum 跟踪源时默认启用 50/60 + 二次谐波） */
  notchHz?: number[];
}

export interface EngineOutput {
  channels: [Float32Array, Float32Array];
  sampleRate: number;
  drift: WowFlutterReport;
  azimuth: AzimuthResult;
  eq: EqDesign[];
  trackHz: number;
  trackSource: string;
  elapsedMs: number;
  realtimeFactor: number;
}

export class RestorationEngine {
  private ctx: OfflineAudioContext | null = null;
  private workletsReady: Promise<void>;

  constructor(public sampleRate: number, public channels = 2, private lengthFrames = 1) {
    this.workletsReady = this.boot();
  }

  private async boot(): Promise<void> {
    this.ctx = new OfflineAudioContext(this.channels, Math.max(1, this.lengthFrames), this.sampleRate);
    await this.ctx.audioWorklet.addModule(TRACKER_WORKLET_URL);
    await this.ctx.audioWorklet.addModule(RESTORATION_WORKLET_URL);
  }

  /** 完整修复流程（输入整块立体声音频；分块在 OAC 渲染内部按量子推进） */
  async run(input: EngineInput): Promise<EngineOutput> {
    const t0 = performance.now();
    const [chL, chR] = input.channels;
    const sr = input.sampleRate;
    const n = Math.min(chL.length, chR.length);
    const progress = input.onProgress ?? (() => {});

    // ---------- 1) 检测跟踪源 ----------
    progress({ phase: 'detect', fraction: 0.02, message: '检测参考音/交流哼声…' });
    const headLen = Math.min(n, sr * 10);
    const head = new Float32Array(headLen);
    for (let i = 0; i < headLen; i++) head[i] = 0.5 * (chL[i] + chR[i]);
    const detected = detectReferenceOrHum(head, sr, input.spec.refToneHz || 1000);
    const trackHz = input.forceTrackHz ?? detected?.frequency ?? input.spec.humHz;
    const trackSource = input.forceTrackHz
      ? `手动指定 ${input.forceTrackHz.toFixed(1)}Hz`
      : detected
        ? `${detected.kind === 'hum' ? '交流哼声' : '参考音'} ${detected.frequency.toFixed(1)}Hz（纯度 ${(detected.purity * 100).toFixed(0)}%）`
        : `回退哼声 ${input.spec.humHz}Hz`;
    if (!(trackHz > 0 && trackHz < sr / 2)) throw new Error('未找到可用的抖晃跟踪频率');

    // ---------- 2) 第一遍：抖晃跟踪（Worklet） ----------
    progress({ phase: 'tracking', fraction: 0.08, message: 'Worklet 跟踪抖晃曲线…' });
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = 0.5 * (chL[i] + chR[i]);
    const points = await this.runTrackingPass(mono, sr, trackHz, f =>
      progress({ phase: 'tracking', fraction: 0.08 + f * 0.25, message: 'Worklet 跟踪抖晃曲线…' }));
    const curve = buildCorrectionCurve(points);
    if (curve.length < 8) throw new Error('跟踪有效数据不足，请确认参考音或哼声存在');
    const drift = summarizeWowFlutter(curve, trackSource);

    // ---------- 3) 方位角估计（主线程 FFT，复用纯 TS 核） ----------
    progress({ phase: 'azimuth', fraction: 0.38, message: 'GCC-PHAT 估计磁头方位角…' });
    const azimuth = estimateAzimuth(chL, chR, { ...input.spec, sampleRate: sr });

    // ---------- 4) 高频补偿设计 ----------
    progress({ phase: 'eq', fraction: 0.46, message: '测量频响并设计逆补偿 FIR…' });
    const eq: EqDesign[] = [];
    for (const ch of [chL, chR]) {
      const { freqs, gain } = measureResponse(ch.subarray(0, n), sr);
      const d = designInverseEq(Float64Array.from(freqs), Float64Array.from(gain), sr);
      eq.push({
        fir: d.fir,
        freqs: d.freqs,
        targetGain: d.targetGain,
        measuredGain: d.measuredGain,
        residualAt10kDb: d.residualAt10kDb,
        alignDelay: 0,
      });
    }

    // ---------- 5) 第二遍：修复滤波 Worklet（分块续算） ----------
    progress({ phase: 'restoring', fraction: 0.55, message: 'Worklet 执行校正与滤波…' });
    const restored = await this.runRestorationPass(
      chL.subarray(0, n), chR.subarray(0, n), sr, curve, azimuth, eq, input,
      trackSource,
      f => progress({ phase: 'restoring', fraction: 0.55 + f * 0.4, message: 'Worklet 执行校正与滤波…' }),
    );

    const elapsedMs = performance.now() - t0;
    const audioSec = n / sr;
    progress({ phase: 'done', fraction: 1, message: '修复完成' });
    return {
      channels: restored,
      sampleRate: sr,
      drift,
      azimuth,
      eq,
      trackHz,
      trackSource,
      elapsedMs,
      realtimeFactor: (audioSec * 1000) / elapsedMs,
    };
  }

  /** 第一遍：跟踪 Worklet 跑完整段，收集块级点 */
  private async runTrackingPass(
    mono: Float32Array, sr: number, _f0: number, onFraction: (f: number) => void,
  ): Promise<DriftPoint[]> {
    await this.workletsReady;
    const n = mono.length;
    const ctx = new OfflineAudioContext(1, n, sr);
    await ctx.audioWorklet.addModule(TRACKER_WORKLET_URL);
    const node = new AudioWorkletNode(ctx, 'wow-flutter-tracker', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    const src = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, n, sr);
    buf.copyToChannel(Float32Array.from(mono), 0);
    src.buffer = buf;
    src.connect(node).connect(ctx.destination);

    const collected: DriftPoint[] = [];
    node.port.onmessage = (ev: MessageEvent) => {
      if (ev.data.type === 'points') collected.push(...ev.data.points);
    };
    src.start();
    // OAC 无法中途报进度；按长度给确定性推进（渲染通常很快）
    const timer = setInterval(() => onFraction(Math.min(0.95, collected.length * 256 / n)), 120);
    await ctx.startRendering();
    clearInterval(timer);
    node.port.postMessage({ type: 'flush' });
    onFraction(1);
    return collected;
  }

  /** 第二遍：修复 Worklet，按 chunkSec 分块渲染并在块间序列化状态 */
  private async runRestorationPass(
    chL: Float32Array, chR: Float32Array, sr: number,
    curve: DriftPoint[], azimuth: AzimuthResult, eq: EqDesign[],
    input: EngineInput, trackSource: string, onFraction: (f: number) => void,
  ): Promise<[Float32Array, Float32Array]> {
    await this.workletsReady;
    const n = chL.length;
    const chunkFrames = Math.floor((input.chunkSec ?? 60) * sr);
    // 跟踪源是哼声时，默认加 50/60Hz 及其二次谐波陷波；参考音不动（避免误伤节目）
    const notchHz = input.notchHz ?? (trackSource.startsWith('交流哼声')
      ? [input.spec.humHz, input.spec.humHz * 2]
      : []);

    // 方位对齐：把测量到的 L-R 延迟平分到两通道（各自延迟 ≤1.5 样本）
    const halfDelay = azimuth.delaySamples / 2;
    const delays: [number, number] = [
      Math.max(0, halfDelay),
      Math.max(0, -halfDelay),
    ];

    const outL: Float32Array[] = [];
    const outR: Float32Array[] = [];
    let state: { produced: number; consumed: number } | null = null;

    const chunks = Math.ceil(n / chunkFrames);
    for (let start = 0, ci = 0; start < n; start += chunkFrames, ci++) {
      const isLast = ci === chunks - 1;
      const end = Math.min(n, start + chunkFrames);
      const len = end - start;
      // 预估输出长度（速度比均值 ±3% 余量 + 滤波器延迟冲洗）
      const estLen = Math.ceil(len * 1.03) + 600;
      const ctx = new OfflineAudioContext(2, estLen, sr);
      await ctx.audioWorklet.addModule(RESTORATION_WORKLET_URL);
      const node = new AudioWorkletNode(ctx, 'restoration-processor', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      });
      node.port.postMessage({
        type: 'configure',
        sampleRate: sr,
        curve,
        delays,
        firL: Array.from(eq[0].fir),
        firR: Array.from(eq[1].fir),
        notchHz,
      });
      if (state) node.port.postMessage({ type: 'state', state });

      const snap = new Promise<WorkletSnapshot>(resolve => {
        node.port.onmessage = (ev: MessageEvent) => {
          if (ev.data.type === 'state') resolve(ev.data.state as WorkletSnapshot);
        };
      });
      // 末块补零，冲洗 FIR/分数延迟的群延迟
      const pad = isLast ? 512 : 0;
      const buf = ctx.createBuffer(2, len + pad, sr);
      buf.copyToChannel(Float32Array.from(chL.subarray(start, end)), 0);
      buf.copyToChannel(Float32Array.from(chR.subarray(start, end)), 1);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(node).connect(ctx.destination);
      src.start();
      const rendered = await ctx.startRendering();

      // 渲染已结束，请求状态快照（消息在下一个微任务投递）
      node.port.postMessage({ type: 'snapshot' });
      const snapState = await snap;
      const producedInChunk = snapState.produced - (state?.produced ?? 0);
      const gotL = rendered.getChannelData(0);
      const gotR = rendered.getChannelData(1);
      const valid = Math.min(producedInChunk, gotL.length, gotR.length);
      outL.push(Float32Array.from(gotL.subarray(0, valid)));
      outR.push(Float32Array.from(gotR.subarray(0, valid)));
      state = snapState;
      onFraction(end / n);
    }

    const total = outL.reduce((s, p) => s + p.length, 0);
    const finalL = concat(outL, total);
    const finalR = concat(outR, total);
    return [finalL, finalR];
  }
}

interface WorkletSnapshot {
  produced: number;
  consumed: number;
}

function concat(parts: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out.subarray(0, off);
}

/**
 * 纯内核参考实现（Node/单测用，不依赖 Worklet）：
 * 同样的跟踪核与滤波链，便于 CI 验证算法正确性与吞吐。
 */
export function runTrackingKernel(mono: Float32Array, sr: number, f0: number, blockSize = 256): DriftPoint[] {
  const tracker = new WowFlutterTracker(sr, f0, blockSize);
  const points: DriftPoint[] = [];
  for (let i = 0; i < mono.length; i++) {
    const p = tracker.process(mono[i]);
    if (p) points.push(p);
  }
  return points;
}
