/**
 * AudioWorklet：立体声 FIR 修复滤波器。
 *
 * 协议：
 *   入：{ type:'config', tapsLeft: Float64Array|number[], tapsRight: number[] }
 *   出：直通修复后的立体声；{ type:'done' }（flush 时）
 *       { type:'level', rmsL, rmsB } 每若干秒上报一次电平
 *
 * 时域直接卷积（滤波器 65–129 抽头，128 样本块下每块约 1.6 万次乘加，
 * 现代设备实时余量充足；离线渲染时按机器速度尽快跑）。
 * 每条声道维护自己的历史环形缓冲，天然支持流式分块。
 */
class StereoFirProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.tapsL = null;
    this.tapsR = null;
    this.histL = null;
    this.histR = null;
    this.histPos = 0;
    this.sampleCount = 0;
    this.accL = 0;
    this.accR = 0;
    this.port.onmessage = (ev) => this.handleMessage(ev.data);
  }

  handleMessage(msg) {
    if (msg.type === 'config') {
      this.tapsL = Float64Array.from(msg.tapsLeft);
      this.tapsR = Float64Array.from(msg.tapsRight);
      const M = Math.max(this.tapsL.length, this.tapsR.length);
      this.histL = new Float64Array(M);
      this.histR = new Float64Array(M);
      this.histPos = 0;
    } else if (msg.type === 'flush') {
      this.port.postMessage({ type: 'done' });
    }
  }

  convolve(hist, pos, x, taps) {
    const M = taps.length;
    hist[pos] = x;
    let acc = 0;
    for (let k = 0; k < M; k++) {
      // 历史按时间倒序读取：最新样本在 pos，最旧在 pos+1（环形）
      const idx = (pos - k + M) % M;
      acc += taps[k] * hist[idx];
    }
    return acc;
  }

  process(inputs, outputs) {
    if (!this.tapsL) {
      const out = outputs[0];
      const inp = inputs[0];
      if (inp && inp.length) {
        for (let c = 0; c < Math.min(out.length, inp.length); c++) out[c].set(inp[c]);
      }
      return true;
    }
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    const inL = input[0];
    const inR = input[1] || input[0];
    const outL = output[0];
    const outR = output[1] || output[0];
    const M = this.histL.length;

    for (let i = 0; i < inL.length; i++) {
      outL[i] = this.convolve(this.histL, this.histPos, inL[i], this.tapsL);
      outR[i] = this.convolve(this.histR, this.histPos, inR[i], this.tapsR);
      this.histPos = (this.histPos + 1) % M;
      this.accL += outL[i] * outL[i];
      this.accR += outR[i] * outR[i];
      this.sampleCount++;
    }

    // 每约 1 秒上报一次电平
    if (this.sampleCount >= globalThis.sampleRate) {
      this.port.postMessage({
        type: 'level',
        rmsL: Math.sqrt(this.accL / this.sampleCount),
        rmsR: Math.sqrt(this.accR / this.sampleCount),
      });
      this.accL = 0;
      this.accR = 0;
      this.sampleCount = 0;
    }
    return true;
  }
}

registerProcessor('stereo-fir', StereoFirProcessor);
