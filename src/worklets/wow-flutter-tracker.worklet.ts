import { WowFlutterTracker } from '../dsp/wow-flutter';
import type { DriftPoint } from '../dsp/types';

/**
 * 抖晃跟踪 Worklet。
 * 输入 0：单声道（已下混的参考音/哼声）。
 * 输出：透传输入（便于串接分析节点），块级跟踪结果通过 port 发出。
 *
 * 消息协议（port.postMessage）：
 *   入: { type:'init', sampleRate, f0, blockSize, bandwidthHz, state? }
 *   入: { type:'state', state }            分块续算
 *   出: { type:'points', points:DriftPoint[] }
 *   出: { type:'state', state }            每渲染量子结束回传
 */
class WowFlutterTrackerProcessor extends AudioWorkletProcessor {
  private tracker: WowFlutterTracker | null = null;
  private pending: DriftPoint[] = [];

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent) => {
      const msg = ev.data;
      if (msg.type === 'init') {
        this.tracker = new WowFlutterTracker(msg.sampleRate, msg.f0, msg.blockSize ?? 256, msg.bandwidthHz ?? 120);
        if (msg.state) this.tracker.setState(msg.state);
      } else if (msg.type === 'state' && this.tracker) {
        this.tracker.setState(msg.state);
      } else if (msg.type === 'flush') {
        this.emit(true);
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const mono = input[0];
    // 透传（若接了输出）
    if (output && output.length > 0) output[0].set(mono);

    if (this.tracker) {
      for (let i = 0; i < mono.length; i++) {
        const p = this.tracker.process(mono[i]);
        if (p) {
          this.pending.push(p);
          if (this.pending.length >= 64) this.emit(false);
        }
      }
    }
    return true;
  }

  private emit(flush: boolean): void {
    if (this.pending.length === 0 && !flush) return;
    this.port.postMessage({ type: 'points', points: this.pending.splice(0) }, []);
    if (flush && this.tracker) {
      this.port.postMessage({ type: 'state', state: this.tracker.getState() });
    }
  }
}

registerProcessor('wow-flutter-tracker', WowFlutterTrackerProcessor);
