import { VariableRateResampler, FractionalDelay } from '../dsp/resampler';
import { FirFilter, BiquadNotch } from '../dsp/eq-design';
import type { DriftPoint } from '../dsp/types';

interface WorkletState {
  resamplerL: ReturnType<VariableRateResampler['getState']>;
  resamplerR: ReturnType<VariableRateResampler['getState']>;
  delayL: ReturnType<FractionalDelay['getState']>;
  delayR: ReturnType<FractionalDelay['getState']>;
  firL: ReturnType<FirFilter['getState']>;
  firR: ReturnType<FirFilter['getState']>;
  produced: number;
  consumed: number;
}

/**
 * 修复滤波 Worklet（立体声）。
 * 级联顺序（每通道）：
 *   变速重采样（抖晃校正）→ 分数延迟（方位对齐）→ FIR（高频补偿）→ 陷波（哼声）
 *
 * 消息协议：
 *   入: { type:'configure', curve:DriftPoint[], delays:[dL,dR],
 *          firL:number[], firR:number[], notchHz:number[] }
 *   入: { type:'state', state }
 *   出: { type:'state', state }
 *   出: { type:'stats', produced, consumed }
 */
class RestorationProcessor extends AudioWorkletProcessor {
  private resL: VariableRateResampler | null = null;
  private resR: VariableRateResampler | null = null;
  private dlyL: FractionalDelay | null = null;
  private dlyR: FractionalDelay | null = null;
  private firL: FirFilter | null = null;
  private firR: FirFilter | null = null;
  private notchesL: BiquadNotch[] = [];
  private notchesR: BiquadNotch[] = [];
  private produced = 0;
  private consumed = 0;
  private configured = false;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent) => {
      const msg = ev.data;
      if (msg.type === 'configure') this.configure(msg);
      else if (msg.type === 'state') this.restoreState(msg.state);
      else if (msg.type === 'snapshot') this.snapshot();
    };
  }

  private snapshot(): void {
    if (!this.configured) return;
    this.port.postMessage({
      type: 'state',
      state: {
        resamplerL: this.resL!.getState(),
        resamplerR: this.resR!.getState(),
        delayL: this.dlyL!.getState(),
        delayR: this.dlyR!.getState(),
        firL: this.firL!.getState(),
        firR: this.firR!.getState(),
        produced: this.produced,
        consumed: this.consumed,
      } satisfies WorkletState,
    });
  }

  private configure(cfg: {
    sampleRate: number;
    curve: DriftPoint[];
    delays: [number, number];
    firL: number[];
    firR: number[];
    notchHz: number[];
  }): void {
    this.resL = new VariableRateResampler(cfg.sampleRate, cfg.curve);
    this.resR = new VariableRateResampler(cfg.sampleRate, cfg.curve);
    this.dlyL = new FractionalDelay(cfg.delays[0]);
    this.dlyR = new FractionalDelay(cfg.delays[1]);
    this.firL = new FirFilter(Float32Array.from(cfg.firL));
    this.firR = new FirFilter(Float32Array.from(cfg.firR));
    this.notchesL = cfg.notchHz.map(f => new BiquadNotch(f, 20, cfg.sampleRate));
    this.notchesR = cfg.notchHz.map(f => new BiquadNotch(f, 20, cfg.sampleRate));
    this.configured = true;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];
    if (!this.configured || !input || input.length < 2 || !output || output.length < 2) {
      return true;
    }
    const inL = input[0];
    const inR = input[1];
    const outL = output[0];
    const outR = output[1];

    // 1) 变速重采样（两通道共用曲线，长度一致）
    const aL = this.resL!.process(inL);
    const aR = this.resR!.process(inR);
    const len = Math.min(aL.length, aR.length, outL.length);
    this.consumed += inL.length;

    for (let i = 0; i < len; i++) {
      // 2) 方位对齐
      let xL = this.dlyL!.process(aL[i]);
      let xR = this.dlyR!.process(aR[i]);
      // 3) 高频补偿
      xL = this.firL!.process(xL);
      xR = this.firR!.process(xR);
      // 4) 哼声陷波
      for (const n of this.notchesL) xL = n.process(xL);
      for (const n of this.notchesR) xR = n.process(xR);
      outL[i] = xL;
      outR[i] = xR;
    }
    // 重采样产出不足时，输出尾部保持静音（引擎按实际产出裁切）
    for (let i = len; i < outL.length; i++) {
      outL[i] = 0;
      outR[i] = 0;
    }
    this.produced += len;
    return true;
  }

  private restoreState(s: WorkletState): void {
    this.resL?.setState(s.resamplerL);
    this.resR?.setState(s.resamplerR);
    this.dlyL?.setState(s.delayL);
    this.dlyR?.setState(s.delayR);
    this.firL?.setState(s.firL);
    this.firR?.setState(s.firR);
    this.produced = s.produced;
    this.consumed = s.consumed;
  }
}

registerProcessor('restoration-processor', RestorationProcessor);
