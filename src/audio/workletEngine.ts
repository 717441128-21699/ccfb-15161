/**
 * AudioWorklet 加载与离线渲染封装。
 * 所有工作单元都跑在 OfflineAudioContext 里，可按机器能力快于实时，
 * 这是“60 分钟磁带 2 分钟内处理完”指标的基础。
 */

const WORKLET_BASE = './worklets';

let audioContext: AudioContext | null = null;

/** 实时试听用的共享 AudioContext（延迟加载）。 */
export function getAudioContext(): AudioContext {
  if (!audioContext) audioContext = new AudioContext();
  return audioContext;
}

export interface WorkletNode {
  node: AudioWorkletNode;
  context: BaseAudioContext;
}

/** 在指定上下文里创建 worklet 节点（自动先 addModule）。 */
export async function createWorklet(
  context: BaseAudioContext,
  name: 'pilot-tracker' | 'azimuth-estimator' | 'stereo-fir',
): Promise<AudioWorkletNode> {
  const file =
    name === 'pilot-tracker'
      ? 'pilot-tracker-worklet.js'
      : name === 'azimuth-estimator'
        ? 'azimuth-estimator-worklet.js'
        : 'stereo-fir-worklet.js';
  await context.audioWorklet.addModule(`${WORKLET_BASE}/${file}`);
  return new AudioWorkletNode(context, name);
}

function waitForMessage(port: MessagePort, type: string): Promise<any> {
  return new Promise((resolve) => {
    const handler = (ev: MessageEvent) => {
      if (ev.data?.type === type) {
        port.removeEventListener('message', handler);
        resolve(ev.data);
      }
    };
    port.addEventListener('message', handler);
  });
}

export interface TrackerWorkletResult {
  ratesPerSecond: Float64Array;
  points: Array<{ t: number; rate: number; confidence: number }>;
}

/** 离线跑参考音跟踪，返回每秒速率图。 */
export async function runTrackerOffline(
  buffer: AudioBuffer,
  referenceHz: number,
  harmonics: number[],
  frameSize = 2048,
): Promise<TrackerWorkletResult> {
  const ctx = new OfflineAudioContext(2, buffer.length, buffer.sampleRate);
  const node = await createWorklet(ctx, 'pilot-tracker');
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(node);
  node.connect(ctx.destination);

  let rates: Float64Array | null = null;
  let points: TrackerWorkletResult['points'] = [];
  const done = new Promise<void>((resolve) => {
    node.port.addEventListener('message', (ev: MessageEvent) => {
      if (ev.data?.type === 'rates') rates = ev.data.ratesPerSecond as Float64Array;
      else if (ev.data?.type === 'points') points = ev.data.points;
      else if (ev.data?.type === 'done') resolve();
    });
  });
  node.port.start();
  node.port.postMessage({
    type: 'config',
    sampleRate: buffer.sampleRate,
    referenceHz,
    harmonics,
    frameSize,
    hopSize: frameSize >> 2,
  });
  src.start();
  node.port.postMessage({ type: 'flush', duration: buffer.duration });
  await ctx.startRendering();
  await done;
  if (!rates) throw new Error('跟踪 Worklet 未返回速率图');
  return { ratesPerSecond: rates, points };
}

export interface AzimuthWorkletResult {
  delaySeconds: number;
  delayStdSeconds: number;
  residualRms: number;
  binsUsed: number;
  coherence: number;
  frames: number;
}

/** 离线跑方位角估计（仅消费开头足够的帧数，工作节点自行截断）。 */
export async function runAzimuthOffline(
  buffer: AudioBuffer,
  opts: { fftSize?: number; minFreqHz?: number; maxFreqHz?: number; maxFrames?: number } = {},
): Promise<AzimuthWorkletResult> {
  const ctx = new OfflineAudioContext(2, buffer.length, buffer.sampleRate);
  const node = await createWorklet(ctx, 'azimuth-estimator');
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(node);
  node.connect(ctx.destination);

  const estimateP = waitForMessage(node.port, 'estimate');
  node.port.postMessage({
    type: 'config',
    sampleRate: buffer.sampleRate,
    fftSize: opts.fftSize ?? 2048,
    minFreqHz: opts.minFreqHz ?? 300,
    maxFreqHz: opts.maxFreqHz ?? 8000,
    maxFrames: opts.maxFrames ?? 48,
  });
  src.start();
  node.port.postMessage({ type: 'flush' });
  await ctx.startRendering();
  const msg = await estimateP;
  return msg.estimate as AzimuthWorkletResult;
}

/**
 * 离线跑立体声 FIR，返回修复后的 AudioBuffer。
 */
export async function runFirOffline(
  buffer: AudioBuffer,
  tapsLeft: ArrayLike<number>,
  tapsRight: ArrayLike<number>,
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, buffer.length, buffer.sampleRate);
  const node = await createWorklet(ctx, 'stereo-fir');
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(node);
  node.connect(ctx.destination);
  node.port.postMessage({
    type: 'config',
    tapsLeft: Array.from(tapsLeft),
    tapsRight: Array.from(tapsRight),
  });
  src.start();
  return ctx.startRendering();
}
