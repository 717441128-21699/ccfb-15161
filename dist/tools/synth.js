// 测试磁带合成:对位音 + 节目内容 + 哼声,再叠加抖晃(正弦 wow/flutter + 随机漂移)
// 和方位角劣化(声道间分数延时 + 每轨 sinc 高频损耗)。同时输出未劣化的参考带。
// 用法: node dist/tools/synth.js [outDir]   —— 生成一组测试 WAV
import { fft, fftConvolve } from '../src/dsp/fft.js';
import { sincInterpAt } from '../src/dsp/interp.js';
import { CASSETTE_PARAMS } from '../src/dsp/azimuth.js';
import { encodeWav } from '../src/dsp/wav.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
/** 确定性伪随机(mulberry32) */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** 方位角损耗 FIR(前向劣化用):H(f)=sinc(π·W·tanθ·f/v) */
function azimuthLossFir(angleRad, fs, params, numTaps = 255) {
    const nfft = 4096;
    const gain = new Float64Array(nfft);
    for (let k = 0; k < nfft / 2; k++) {
        const f = (k * fs) / nfft;
        const x = (Math.PI * params.trackWidthMm * Math.tan(angleRad) * f) / params.tapeSpeedMms;
        const g = Math.abs(x) < 1e-9 ? 1 : Math.sin(x) / x;
        gain[k] = g;
        gain[nfft - 1 - k] = g;
    }
    const re = gain, im = new Float64Array(nfft);
    fft(re, im, true);
    const half = (numTaps - 1) / 2;
    const taps = new Float32Array(numTaps);
    for (let i = 0; i < numTaps; i++) {
        const idx = ((i - half) + nfft) % nfft;
        taps[i] = re[idx] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (numTaps - 1)));
    }
    return taps;
}
export function synthesize(opts = {}) {
    const fs = opts.fs ?? 44100;
    const toneSec = opts.toneSec ?? 6;
    const dur = opts.durationSec ?? 46;
    const wowAmp = opts.wowAmp ?? 0.006, wowHz = opts.wowHz ?? 0.7;
    const flAmp = opts.flutterAmp ?? 0.0015, flHz = opts.flutterHz ?? 7;
    const driftAmp = opts.driftAmp ?? 0.001;
    const azArcmin = opts.azimuthArcmin ?? 5;
    const humDb = opts.humDb ?? -35;
    const params = opts.params ?? CASSETTE_PARAMS;
    const rand = rng(opts.seed ?? 1234);
    const N = Math.floor(dur * fs);
    const L = new Float32Array(N);
    const R = new Float32Array(N);
    const toneN = Math.floor(toneSec * fs);
    // --- 内容 ---
    // 带首对位音 1kHz @ -12dBFS
    for (let i = 0; i < toneN; i++) {
        const t = i / fs;
        const env = Math.min(1, Math.min(i, toneN - i) / (0.05 * fs));
        const v = 0.25 * env * Math.sin(2 * Math.PI * 1000 * t);
        L[i] = v;
        R[i] = v;
    }
    // 节目:谐波簇 + 宽带噪声(含高频,供方位角估计)+ 中段 10kHz 校准音
    const calStart = toneN + Math.floor((N - toneN) * 0.45);
    const calLen = Math.floor(4 * fs);
    // 噪声用确定性随机 + 简单谱整形
    let lp1 = 0, lp2 = 0;
    for (let i = toneN; i < N; i++) {
        const t = i / fs;
        // 谐波簇(模拟音乐/语音基频结构)
        let v = 0.11 * Math.sin(2 * Math.PI * 220 * t)
            + 0.07 * Math.sin(2 * Math.PI * 331 * t + 1)
            + 0.05 * Math.sin(2 * Math.PI * 553 * t + 2)
            + 0.03 * Math.sin(2 * Math.PI * 890 * t);
        // 宽带噪声,一阶低通整形但保留高频成分
        const w = rand() * 2 - 1;
        lp1 += 0.25 * (w - lp1);
        lp2 += 0.05 * (w - lp2);
        v += 0.05 * lp1 + 0.06 * (w - lp2); // 高频差分分量保证 4-16kHz 有内容
        // 10kHz 校准音 @ -20dBFS
        if (i >= calStart && i < calStart + calLen) {
            const env = Math.min(1, Math.min(i - calStart, calStart + calLen - i) / (0.05 * fs));
            v += 0.1 * env * Math.sin(2 * Math.PI * 10000 * t);
        }
        // 立体声去相关:右声道噪声序列略不同(用不同抽头),内容主体相关
        L[i] = v;
        R[i] = v + 0.004 * (rand() * 2 - 1);
    }
    // 节目内容 100Hz 高通(真实采访带节目段在工频附近没有能量,哼声因此可跟踪)
    {
        const w0 = Math.tan((Math.PI * 100) / fs);
        const k = w0 * w0;
        const norm = 1 / (1 + Math.SQRT1_2 * 2 * w0 + k);
        const b0 = norm, b1 = -2 * norm, b2 = norm;
        const a1 = 2 * (k - 1) * norm, a2 = (1 - Math.SQRT1_2 * 2 * w0 + k) * norm;
        for (const ch of [L, R]) {
            let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
            for (let i = 0; i < N; i++) {
                const x0 = ch[i];
                const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
                x2 = x1;
                x1 = x0;
                y2 = y1;
                y1 = y0;
                ch[i] = y0;
            }
        }
    }
    // 哼声 50Hz(录在磁带上,随后一起被抖晃调制)
    const humAmp = Math.pow(10, humDb / 20);
    for (let i = 0; i < N; i++) {
        const h = humAmp * Math.sin(2 * Math.PI * 50 * (i / fs));
        L[i] += h;
        R[i] += h;
    }
    // 参考带(未劣化)拷贝
    const refL = L.slice();
    const refR = R.slice();
    // --- 劣化 1:抖晃(时变速度)---
    // 随机漂移:低通随机游走
    const drift = new Float32Array(N);
    let dw = 0;
    const dAlpha = 1 - Math.exp((-2 * Math.PI * 0.25) / fs);
    let dRms = 0;
    for (let i = 0; i < N; i++) {
        dw += dAlpha * ((rand() * 2 - 1) * 0.02 - dw);
        drift[i] = dw;
        dRms += dw * dw;
    }
    dRms = Math.sqrt(dRms / N) || 1;
    const driftScale = driftAmp / dRms;
    const eps = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        const t = i / fs;
        eps[i] = wowAmp * Math.sin(2 * Math.PI * wowHz * t)
            + flAmp * Math.sin(2 * Math.PI * flHz * t)
            + drift[i] * driftScale;
    }
    // 位置 = ∫(1+ε)dt,从位置轨迹反向采样:输出 i 读输入 pos(i)
    const wowL = new Float32Array(N);
    const wowR = new Float32Array(N);
    let pos = 3;
    for (let i = 0; i < N; i++) {
        const p = Math.min(pos, N - 7);
        wowL[i] = sincInterpAt(L, p);
        wowR[i] = sincInterpAt(R, p);
        pos += 1 + eps[i];
    }
    // --- 劣化 2:方位角 ---
    const theta = ((azArcmin / 60) * Math.PI) / 180;
    const dt = (params.trackSpacingMm * Math.tan(theta)) / params.tapeSpeedMms; // 秒
    const dSamp = dt * fs;
    // R 声道分数延时(先拷贝,避免就地读写污染)
    let delR = wowR;
    if (Math.abs(dSamp) > 1e-3) {
        const src = wowR.slice();
        delR = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            const p = i - dSamp;
            delR[i] = p >= 3 && p < N - 5 ? sincInterpAt(src, p) : 0;
        }
    }
    // 每轨 sinc 高频损耗
    const lossFir = azimuthLossFir(theta, fs, params);
    const outL = fftConvolve(wowL, lossFir);
    const outR = fftConvolve(delR, lossFir);
    return {
        L: outL, R: outR, refL, refR, fs,
        calStart, calLen, trueAzimuthArcmin: azArcmin,
        epsTrue: eps,
    };
}
// CLI:生成一组测试磁带 WAV
import { fileURLToPath } from 'node:url';
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
    const outDir = process.argv[2] ?? 'test-tapes';
    fs.mkdirSync(outDir, { recursive: true });
    const scenarios = [
        { name: 'wow-low_az-2min', opts: { wowAmp: 0.003, wowHz: 0.8, flutterAmp: 0.0008, flutterHz: 6, driftAmp: 0.0005, azimuthArcmin: 2 } },
        { name: 'wow-mid_az-5min', opts: { wowAmp: 0.007, wowHz: 0.6, flutterAmp: 0.0015, flutterHz: 8, driftAmp: 0.001, azimuthArcmin: 5 } },
        { name: 'wow-high_az-10min', opts: { wowAmp: 0.012, wowHz: 1.1, flutterAmp: 0.003, flutterHz: 10, driftAmp: 0.002, azimuthArcmin: 10 } },
        { name: 'wow-mid_az-15min', opts: { wowAmp: 0.006, wowHz: 0.5, flutterAmp: 0.001, flutterHz: 5, driftAmp: 0.001, azimuthArcmin: 15 } },
    ];
    for (const s of scenarios) {
        const r = synthesize(s.opts);
        fs.writeFileSync(path.join(outDir, `${s.name}.wav`), encodeWav([r.L, r.R], r.fs, 24));
        fs.writeFileSync(path.join(outDir, `${s.name}_reference.wav`), encodeWav([r.refL, r.refR], r.fs, 24));
        console.log(`已生成 ${s.name}.wav(方位角 ${s.opts.azimuthArcmin} 角分)`);
    }
}
