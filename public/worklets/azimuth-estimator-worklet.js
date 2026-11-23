/**
 * AudioWorklet：方位角估计器（时域粗互相关 + 分数 MSE 精修）。
 * 与 src/dsp/azimuth.ts 同构，Worklet 内不依赖 FFT。
 *
 * 协议：
 *   入：{ type:'config', sampleRate, frameSize, maxFrames, maxLagSamples }
 *       { type:'flush' }
 *   出：{ type:'estimate', estimate: { delaySeconds, delayStdSeconds,
 *           residualRms, binsUsed, coherence, frames } }
 *       { type:'done' }
 */
class AzimuthEstimatorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cfg = null;
    this.ringL = null;
    this.ringR = null;
    this.ringLen = 0;
    this.ringHead = 0;
    this.frames = [];
    this.port.onmessage = (ev) => this.handleMessage(ev.data);
  }

  handleMessage(msg) {
    if (msg.type === 'config') {
      const n = msg.frameSize || 2048;
      this.cfg = {
        sampleRate: msg.sampleRate,
        frameSize: n,
        maxFrames: msg.maxFrames ?? 48,
        maxLagSamples: msg.maxLagSamples ?? 64,
      };
      const cap = n * 2;
      this.ringL = new Float64Array(cap);
      this.ringR = new Float64Array(cap);
      this.ringLen = 0;
      this.ringHead = 0;
      this.frames = [];
      this.window = hann(n);
    } else if (msg.type === 'flush') {
      this.flush();
    }
  }

  push(ring, v) {
    const cap = ring.length;
    ring[(this.ringHead + this.ringLen) % cap] = v;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length < 2 || !this.cfg) return true;
    if (this.frames.length >= this.cfg.maxFrames) return true;

    const L = input[0];
    const R = input[1];
    for (let i = 0; i < L.length; i++) {
      this.push(this.ringL, L[i]);
      this.push(this.ringR, R[i]);
      this.ringLen++;
    }

    const n = this.cfg.frameSize;
    const hop = n >> 2;
    const cap = this.ringL.length;
    while (this.ringLen >= n && this.frames.length < this.cfg.maxFrames) {
      const fr = this.estimateFrame(n, cap);
      if (fr) this.frames.push(fr);
      this.ringHead = (this.ringHead + hop) % cap;
      this.ringLen -= hop;
    }
    return true;
  }

  ringAt(ring, cap, i) {
    return ring[(this.ringHead + i) % cap];
  }

  estimateFrame(n, cap) {
    const win = this.window;
    const maxLag = this.cfg.maxLagSamples;
    const L = this.ringL;
    const R = this.ringR;

    let eL = 0, eR = 0;
    for (let i = 0; i < n; i++) {
      const lv = this.ringAt(L, cap, i);
      const rv = this.ringAt(R, cap, i);
      eL += lv * lv * win[i] * win[i];
      eR += rv * rv * win[i] * win[i];
    }
    const norm = Math.sqrt(eL * eR) + 1e-12;
    let bestLag = 0, bestCorr = -Infinity;
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      let acc = 0;
      if (lag >= 0) {
        for (let i = lag; i < n; i++) {
          acc += this.ringAt(L, cap, i - lag) * this.ringAt(R, cap, i) * win[i] * win[i];
        }
      } else {
        for (let i = 0; i < n + lag; i++) {
          acc += this.ringAt(L, cap, i - lag) * this.ringAt(R, cap, i) * win[i] * win[i];
        }
      }
      const v = acc / norm;
      if (v > bestCorr) { bestCorr = v; bestLag = lag; }
    }
    if (bestCorr < 0.1) return null;

    const sampleL = (pos) => {
      const i = Math.floor(pos);
      const frac = pos - i;
      const i0 = Math.max(0, i - 1), i1 = Math.max(0, i), i2 = Math.min(n - 1, i + 1), i3 = Math.min(n - 1, i + 2);
      const p0 = this.ringAt(L, cap, i0), p1 = this.ringAt(L, cap, i1);
      const p2 = this.ringAt(L, cap, i2), p3 = this.ringAt(L, cap, i3);
      const x = frac, x2 = x * x, x3 = x2 * x;
      return 0.5 * (2 * p1 + (-p0 + p2) * x + (2 * p0 - 5 * p1 + 4 * p2 - p3) * x2 + (-p0 + 3 * p1 - 3 * p2 + p3) * x3);
    };

    const fitStart = 32, fitEnd = n - 32;
    const evaluate = (tau) => {
      let se = 0, sw = 0;
      for (let i = fitStart; i < fitEnd; i++) {
        const pred = sampleL(i - tau);
        const e = this.ringAt(R, cap, i) - pred;
        const w = win[i] * win[i];
        se += w * e * e;
        sw += w;
      }
      return se / sw;
    };

    const step = 0.02;
    let bestTau = bestLag, bestMse = evaluate(bestLag);
    for (let s = -50; s <= 50; s++) {
      const tau = bestLag + s * step;
      const mse = evaluate(tau);
      if (mse < bestMse) { bestMse = mse; bestTau = tau; }
    }
    const y0 = evaluate(bestTau - step), y1 = bestMse, y2 = evaluate(bestTau + step);
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-15) {
      const offset = (0.5 * (y0 - y2)) / denom;
      if (Math.abs(offset) <= 1) bestTau += offset * step;
    }
    const residual = Math.sqrt(bestMse) / (Math.sqrt(eR / n) + 1e-12);
    return { tau: bestTau / this.cfg.sampleRate, residual, coherence: bestCorr };
  }

  flush() {
    if (!this.frames.length) {
      this.port.postMessage({
        type: 'estimate',
        estimate: { delaySeconds: 0, delayStdSeconds: 0, residualRms: Infinity, binsUsed: 0, coherence: 0, frames: 0 },
      });
      this.port.postMessage({ type: 'done' });
      return;
    }
    let wsum = 0, tausum = 0, tausq = 0, resSum = 0, cohSum = 0;
    for (const fr of this.frames) {
      const w = 1 / (fr.residual + 0.05);
      wsum += w; tausum += w * fr.tau; tausq += w * fr.tau * fr.tau;
      resSum += fr.residual; cohSum += fr.coherence;
    }
    const tau = tausum / wsum;
    const tauStd = Math.sqrt(Math.max(0, tausq / wsum - tau * tau));
    this.port.postMessage({
      type: 'estimate',
      estimate: {
        delaySeconds: tau,
        delayStdSeconds: tauStd,
        residualRms: resSum / this.frames.length,
        binsUsed: this.frames.length * this.cfg.frameSize,
        coherence: cohSum / this.frames.length,
        frames: this.frames.length,
      },
    });
    this.port.postMessage({ type: 'done' });
  }
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

registerProcessor('azimuth-estimator', AzimuthEstimatorProcessor);
