/**
 * AudioWorklet：参考音/哼声抖晃跟踪器（加窗 I/Q 正交解调）。
 * 与 src/dsp/tracker.ts 同构：环形缓冲攒帧 → Hann 加窗 I/Q 解调
 * → 递归 NCO → 帧间基带相位差测速，多谐波功率加权融合。
 *
 * 协议：
 *   入：{ type:'config', sampleRate, referenceHz, harmonics:[..], frameSize, hopSize }
 *       { type:'flush', duration }
 *   出：{ type:'rates', ratesPerSecond: Float64Array, duration }
 *       { type:'points', points:[{ t, rate, confidence }] }
 *       { type:'done' }
 */
class PilotTrackerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cfg = null;
    this.ring = null;
    this.ringLen = 0;
    this.ringHead = 0;
    this.frameStart = 0; // 已处理样本总数（全局时间基准）
    this.points = [];
    this.prevPhase = [];
    this.port.onmessage = (ev) => this.handleMessage(ev.data);
  }

  handleMessage(msg) {
    if (msg.type === 'config') {
      const frameSize = msg.frameSize || 2048;
      const hopSize = msg.hopSize || frameSize >> 2;
      const harmonics = msg.harmonics && msg.harmonics.length ? msg.harmonics : [1];
      this.cfg = {
        sampleRate: msg.sampleRate,
        referenceHz: msg.referenceHz,
        harmonics,
        frameSize,
        hopSize,
      };
      this.ring = new Float64Array(frameSize * 2);
      this.ringLen = 0;
      this.ringHead = 0;
      this.frameStart = 0;
      this.points = [];
      this.window = hann(frameSize);
      this.harmonicCfg = harmonics.map((h) => {
        const freq = msg.referenceHz * h;
        const phaseInc = (2 * Math.PI * freq) / msg.sampleRate;
        return {
          freq,
          phaseInc,
          cosInc: Math.cos(phaseInc),
          sinInc: Math.sin(phaseInc),
          prevPhase: null,
        };
      });
    } else if (msg.type === 'flush') {
      this.flush(msg.duration);
    }
  }

  ringPush(v) {
    const cap = this.ring.length;
    this.ring[(this.ringHead + this.ringLen) % cap] = v;
    this.ringLen++;
  }

  ringGet(i) {
    return this.ring[(this.ringHead + i) % this.ring.length];
  }

  ringDrop(n) {
    this.ringHead = (this.ringHead + n) % this.ring.length;
    this.ringLen -= n;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !this.cfg) return true;
    const ch0 = input[0];
    const ch1 = input[1] || input[0];
    for (let i = 0; i < ch0.length; i++) this.ringPush((ch0[i] + ch1[i]) * 0.5);

    const { frameSize: n, hopSize: hop, sampleRate: fs, harmonics } = this.cfg;
    while (this.ringLen >= n) {
      // 帧能量（加窗）
      let frameEnergy = 0;
      for (let i = 0; i < n; i++) {
        const v = this.ringGet(i) * this.window[i];
        frameEnergy += v * v;
      }
      frameEnergy *= 2 / n;

      let rateSum = 0, wSum = 0, confSum = 0;
      for (let h = 0; h < this.harmonicCfg.length; h++) {
        const hc = this.harmonicCfg[h];
        // 加窗 I/Q：NCO 绝对相位从全局帧起点开始
        let cosW = Math.cos(hc.phaseInc * this.frameStart);
        let sinW = Math.sin(hc.phaseInc * this.frameStart);
        let I = 0, Q = 0;
        for (let i = 0; i < n; i++) {
          const x = this.ringGet(i) * this.window[i];
          I += x * cosW;
          Q += x * sinW;
          const nc = cosW * hc.cosInc - sinW * hc.sinInc;
          sinW = cosW * hc.sinInc + sinW * hc.cosInc;
          cosW = nc;
        }
        I *= 2 / n;
        Q *= 2 / n;
        const power = I * I + Q * Q;
        const phase = Math.atan2(Q, I);
        const confidence = Math.min(1, power / (frameEnergy + 1e-12));

        if (hc.prevPhase !== null) {
          let dphi = phase - hc.prevPhase;
          dphi = Math.atan2(Math.sin(dphi), Math.cos(dphi));
          // 频率偏高时基带相位递减，取负号
          const deltaF = -(dphi * fs) / (2 * Math.PI * hop);
          const rate = (hc.freq + deltaF) / hc.freq;
          if (rate > 0.85 && rate < 1.15 && confidence > 1e-6) {
            rateSum += rate * power;
            wSum += power;
            confSum += confidence;
          }
        }
        hc.prevPhase = phase;
      }

      if (wSum > 0) {
        this.points.push({
          t: (this.frameStart + n / 2) / fs,
          rate: rateSum / wSum,
          confidence: Math.min(1, confSum / harmonics.length),
        });
      }
      this.frameStart += hop;
      this.ringDrop(hop);
    }
    return true;
  }

  flush(duration) {
    const fs = this.cfg ? this.cfg.sampleRate : globalThis.sampleRate;
    const seconds = Math.max(1, Math.ceil(duration));
    const rates = new Float64Array(seconds).fill(1);
    const weights = new Float64Array(seconds);
    for (const p of this.points) {
      const idx = Math.min(seconds - 1, Math.max(0, Math.floor(p.t)));
      const w = p.confidence;
      rates[idx] = (rates[idx] * weights[idx] + p.rate * w) / (weights[idx] + w);
      weights[idx] += w;
    }
    for (let i = 0; i < seconds; i++) {
      if (weights[i] === 0) rates[i] = i > 0 ? rates[i - 1] : 1;
    }
    this.port.postMessage({ type: 'rates', ratesPerSecond: rates, duration }, [rates.buffer]);
    this.port.postMessage({ type: 'points', points: this.points });
    this.port.postMessage({ type: 'done' });
  }
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

registerProcessor('pilot-tracker', PilotTrackerProcessor);
