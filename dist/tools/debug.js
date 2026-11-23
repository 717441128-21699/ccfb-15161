// 调试2:逐块打印哼声跟踪输出
import { synthesize } from './synth.js';
import { trackDeviation } from '../src/dsp/wowtrack.js';
const fs = 44100;
const tape = synthesize({ wowAmp: 0.007, wowHz: 0.6, flutterAmp: 0.0015, flutterHz: 8, driftAmp: 0.001, azimuthArcmin: 5, seed: 22 });
const mono = new Float32Array(tape.L.length);
for (let i = 0; i < mono.length; i++)
    mono[i] = 0.5 * (tape.L[i] + tape.R[i]);
// 只用哼声跟踪(主参考也设为50Hz,不用对位音)
const dev = trackDeviation(mono, fs, 50, 512, 12.5, 0);
console.log('t(s) | 跟踪eps% | 真值eps% | source');
for (let t = 8; t < 20; t += 0.5) {
    const p = Math.floor((t * fs) / 512);
    const i = Math.floor(t * fs);
    console.log(`${t.toFixed(1)} | ${(dev.eps[p] * 100).toFixed(3)} | ${(tape.epsTrue[i] * 100).toFixed(3)} | ${dev.source[p]}`);
}
// 纯哼声测试:无节目
const N = fs * 10;
const pure = new Float32Array(N);
let ph = 0;
for (let i = 0; i < N; i++) {
    const t = i / fs;
    const dev0 = 0.005 * Math.sin(2 * Math.PI * 0.8 * t);
    ph += (2 * Math.PI * 50 * (1 + dev0)) / fs;
    pure[i] = 0.018 * Math.sin(ph) + 0.001 * Math.sin(2 * Math.PI * 300 * t);
}
const dev2 = trackDeviation(pure, fs, 50, 512, 12.5, 0);
let s = 0, n = 0;
for (let p = 0; p < dev2.eps.length; p++) {
    const t = (p * 512) / fs;
    const tru = 0.005 * Math.sin(2 * Math.PI * 0.8 * t);
    if (t > 1) {
        s += (dev2.eps[p] - tru) ** 2;
        n++;
    }
}
console.log('纯哼声跟踪误差 RMS = %s%%', (Math.sqrt(s / n) * 100).toFixed(4));
