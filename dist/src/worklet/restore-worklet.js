// AudioWorklet 实时修复处理器:抖晃跟踪 + 校正滤波在音频线程运行。
// 两种模式:
//   curve — 用处理页离线测得的偏差曲线做时变重采样(与离线管线同一套算法)
//   live  — 用 WowTracker 在输入流上实时跟踪参考音
// 之后级联方位角补偿 FIR(EQ)。A/B 切换即 bypass。
import { WowTracker } from '../dsp/wowtrack.js';
// 与 interp.ts 相同的 8 抽头布莱克曼窗 sinc 表(worklet 内自包含,环形缓冲用)
const PHASES = 512;
const TAPS = 8;
const HALF = TAPS / 2;
const sincTable = new Float32Array((PHASES + 1) * TAPS);
{
    const sinc = (x) => (Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
    const blk = (x) => 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);
    for (let p = 0; p <= PHASES; p++) {
        const f = p / PHASES;
        let sum = 0;
        for (let k = 0; k < TAPS; k++) {
            const d = k - (HALF - 1) - f;
            const h = sinc(d) * blk(d / HALF);
            sincTable[p * TAPS + k] = h;
            sum += h;
        }
        for (let k = 0; k < TAPS; k++)
            sincTable[p * TAPS + k] /= sum;
    }
}
const RING_BITS = 17; // 128K 样本 ≈ 3s
const RING = 1 << RING_BITS;
const RING_MASK = RING - 1;
const LATENCY = 8192; // 输入→输出固定延迟(样本)
class RestoreProcessor extends AudioWorkletProcessor {
    ringL = new Float32Array(RING);
    ringR = new Float32Array(RING);
    writeIdx = 0;
    readPos = 0;
    started = false;
    bypass = true;
    // curve 模式
    epsCurve = null;
    epsHop = 512;
    // live 模式
    tracker = null;
    liveEps = 0;
    // EQ
    eqTaps = null;
    eqLineL = new Float32Array(512);
    eqLineR = new Float32Array(512);
    constructor() {
        super();
        this.port.onmessage = (ev) => {
            const m = ev.data;
            switch (m.type) {
                case 'setCurve':
                    this.epsCurve = m.eps instanceof Float32Array ? m.eps : new Float32Array(m.eps);
                    this.epsHop = m.hop | 0;
                    break;
                case 'setEq':
                    this.eqTaps = m.taps instanceof Float32Array ? m.taps : new Float32Array(m.taps);
                    this.eqLineL.fill(0);
                    this.eqLineR.fill(0);
                    break;
                case 'setLive':
                    this.tracker = m.f0 > 0 ? new WowTracker(m.f0, sampleRate, 30) : null;
                    this.liveEps = 0;
                    break;
                case 'bypass':
                    this.bypass = !!m.value;
                    break;
                case 'reset':
                    this.writeIdx = 0;
                    this.readPos = 0;
                    this.started = false;
                    this.ringL.fill(0);
                    this.ringR.fill(0);
                    this.eqLineL.fill(0);
                    this.eqLineR.fill(0);
                    break;
            }
        };
    }
    ringRead(ring, pos) {
        const i = Math.floor(pos);
        const p = Math.round((pos - i) * PHASES) * TAPS;
        const b = i - (HALF - 1);
        let y = 0;
        for (let k = 0; k < TAPS; k++)
            y += sincTable[p + k] * ring[(b + k) & RING_MASK];
        return y;
    }
    eqFilter(line, x) {
        const taps = this.eqTaps;
        const n = taps.length;
        for (let i = n - 1; i > 0; i--)
            line[i] = line[i - 1];
        line[0] = x;
        let y = 0;
        for (let i = 0; i < n; i++)
            y += taps[i] * line[i];
        return y;
    }
    process(inputs, outputs) {
        const inp = inputs[0];
        const out = outputs[0];
        if (!out || out.length === 0)
            return true;
        const nCh = out.length;
        const block = out[0].length;
        const inL = inp && inp[0] ? inp[0] : null;
        const inR = inp && inp.length > 1 && inp[1] ? inp[1] : inL;
        if (this.bypass || !inL) {
            for (let ch = 0; ch < nCh; ch++) {
                const src = ch === 0 ? inL : inR;
                if (src)
                    out[ch].set(src);
                else
                    out[ch].fill(0);
            }
            // bypass 时也让读写指针跟随,切回时不爆音
            if (inL) {
                for (let i = 0; i < block; i++) {
                    this.ringL[this.writeIdx & RING_MASK] = inL[i];
                    this.ringR[this.writeIdx & RING_MASK] = inR[i];
                    this.writeIdx++;
                }
                this.readPos = this.writeIdx - LATENCY;
                this.started = this.writeIdx > LATENCY * 2;
            }
            return true;
        }
        // 写入环形缓冲
        for (let i = 0; i < block; i++) {
            this.ringL[this.writeIdx & RING_MASK] = inL[i];
            this.ringR[this.writeIdx & RING_MASK] = inR[i];
            this.writeIdx++;
        }
        if (!this.started) {
            if (this.writeIdx > LATENCY * 2) {
                this.started = true;
                this.readPos = this.writeIdx - LATENCY;
            }
            else {
                for (let ch = 0; ch < nCh; ch++)
                    out[ch].fill(0);
                return true;
            }
        }
        for (let i = 0; i < block; i++) {
            // 当前偏差:curve 优先,其次 live 跟踪
            let eps = 0;
            if (this.epsCurve && this.epsCurve.length > 0) {
                const p = Math.min(this.epsCurve.length - 1, Math.floor(this.readPos / this.epsHop));
                eps = this.epsCurve[p];
            }
            else if (this.tracker) {
                this.liveEps = this.tracker.processSample(inL[i]);
                eps = this.liveEps;
            }
            let yL = this.ringRead(this.ringL, this.readPos);
            let yR = this.ringRead(this.ringR, this.readPos);
            this.readPos += 1 / (1 + eps);
            // 欠载保护:读指针追上写指针时强制拉开
            if (this.readPos > this.writeIdx - 64)
                this.readPos = this.writeIdx - 64;
            if (this.eqTaps) {
                yL = this.eqFilter(this.eqLineL, yL);
                yR = this.eqFilter(this.eqLineR, yR);
            }
            out[0][i] = yL;
            if (nCh > 1)
                out[1][i] = yR;
        }
        return true;
    }
}
registerProcessor('tape-restore', RestoreProcessor);
