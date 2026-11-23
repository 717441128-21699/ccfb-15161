// 参考音 / 交流电哼声检测。
// 对位音(1kHz 等)一般在带首:用滑动短窗找到它最稳定的段落,避开节目谐波误判。
// 哼声(50/60Hz)贯穿全带。两者频率都用正交解调相位斜率精化到亚赫兹级,
// 否则常值频偏会变成音高校正后的整体走调。
import { rfft, nextPow2 } from './fft.js';
import { Lowpass4 } from './wowtrack.js';
const HUM_CANDIDATES = [50, 60];
function avgSpectrum(x, fs, start, len) {
    const winLen = 8192;
    const hop = 4096;
    const nfft = nextPow2(winLen);
    const mag = new Float64Array(nfft / 2);
    const hann = new Float64Array(winLen);
    for (let i = 0; i < winLen; i++)
        hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / winLen);
    const frame = new Float32Array(winLen);
    let frames = 0;
    const end = Math.min(x.length, start + len);
    for (let pos = start; pos + winLen <= end; pos += hop) {
        for (let i = 0; i < winLen; i++)
            frame[i] = x[pos + i] * hann[i];
        const { re, im } = rfft(frame, nfft);
        for (let k = 0; k < nfft / 2; k++)
            mag[k] += Math.hypot(re[k], im[k]);
        frames++;
    }
    if (frames > 0)
        for (let k = 0; k < mag.length; k++)
            mag[k] /= frames;
    return { mag, binHz: fs / nfft, winLen };
}
function refineFreq(mag, bin, binHz) {
    if (bin <= 0 || bin >= mag.length - 1)
        return bin * binHz;
    const a = mag[bin - 1], b = mag[bin], c = mag[bin + 1];
    const denom = a - 2 * b + c;
    if (Math.abs(denom) < 1e-12)
        return bin * binHz;
    const d = 0.5 * (a - c) / denom;
    return (bin + Math.max(-1, Math.min(1, d))) * binHz;
}
function strongestNarrowPeak(mag, binHz, loHz, hiHz, exclude) {
    const kMin = Math.max(2, Math.round(loHz / binHz));
    const kMax = Math.min(mag.length - 2, Math.round(hiHz / binHz));
    let bestK = 0, bestV = 0;
    for (let k = kMin; k <= kMax; k++) {
        const f = k * binHz;
        if (exclude.some(([a, b]) => f >= a && f <= b))
            continue;
        if (mag[k] > bestV && mag[k] >= mag[k - 1] && mag[k] >= mag[k + 1]) {
            const skirt = 0.5 * (mag[Math.max(1, k - 5)] + mag[Math.min(mag.length - 1, k + 5)]);
            if (mag[k] > skirt * 3) {
                bestV = mag[k];
                bestK = k;
            }
        }
    }
    return bestK > 0
        ? { freq: refineFreq(mag, bestK, binHz), mag: bestV }
        : { freq: 0, mag: 0 };
}
function humPeak(mag, binHz) {
    let best = { freq: 0, mag: 0 };
    for (const cand of HUM_CANDIDATES) {
        const kc = Math.round(cand / binHz);
        let v = 0, kk = kc;
        for (let k = Math.max(1, kc - 2); k <= Math.min(mag.length - 1, kc + 2); k++) {
            if (mag[k] > v) {
                v = mag[k];
                kk = k;
            }
        }
        if (v > best.mag)
            best = { freq: refineFreq(mag, kk, binHz), mag: v };
    }
    return best;
}
/**
 * 正交解调相位斜率精化频率:把粗估计 f0 混频到基带,
 * 相位随时间的平均斜率就是剩余频偏。返回精化后的频率。
 */
export function refineFrequency(x, fs, f0, start, len) {
    const n = Math.min(x.length - start, len);
    if (n < fs)
        return f0;
    // 四阶低通抑制 2·f0 混频镜像(一阶的镜像泄漏会偏置相位斜率)
    const lpI = new Lowpass4(fs, 5);
    const lpQ = new Lowpass4(fs, 5);
    let ph = 0, iLP = 0, qLP = 0;
    const dPh = (2 * Math.PI * f0) / fs;
    // 采集相位序列(抽稀到每 64 样本一个点)
    const dec = 64;
    const m = Math.floor(n / dec);
    const phases = new Float64Array(m);
    let k = 0;
    for (let i = 0; i < n; i++) {
        const c = Math.cos(ph), s = Math.sin(ph);
        ph += dPh;
        if (ph > Math.PI)
            ph -= 2 * Math.PI;
        iLP = lpI.process(x[start + i] * c);
        qLP = lpQ.process(-x[start + i] * s);
        if (i % dec === 0 && k < m)
            phases[k++] = Math.atan2(qLP, iLP);
    }
    // 展开 + 中段线性拟合
    for (let i = 1; i < k; i++) {
        let d = phases[i] - phases[i - 1];
        while (d > Math.PI) {
            phases[i] -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
            d = phases[i] - phases[i - 1];
        }
        phases[i] = phases[i - 1] + d;
    }
    const a = Math.floor(k * 0.1), b = Math.floor(k * 0.9);
    if (b - a < 10)
        return f0;
    let sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
    for (let i = a; i < b; i++) {
        const t = (i * dec) / fs;
        sx += t;
        sy += phases[i];
        sxx += t * t;
        sxy += t * phases[i];
        cnt++;
    }
    const denom = cnt * sxx - sx * sx;
    if (Math.abs(denom) < 1e-12)
        return f0;
    const slope = (cnt * sxy - sx * sy) / denom; // rad/s
    return f0 + slope / (2 * Math.PI);
}
/**
 * 检测参考音。
 * @param headSeconds 带首对位音搜索时长
 * @param humSeconds  哼声搜索时长(覆盖节目段)
 */
export function detectReference(x, fs, headSeconds = 12, humSeconds = 60) {
    const none = { type: 'none', toneFreq: 0, humFreq: 0, primary: 0, levelDb: -Infinity };
    if (x.length < fs * 0.5)
        return none;
    const toDb = (v, winLen) => 20 * Math.log10((v * 2) / (winLen * 0.5) + 1e-12);
    // 带首:滑动 4s 窗找对位音最稳的段落(排除哼声及其谐波频带)
    const headLen = Math.min(x.length, Math.floor(headSeconds * fs));
    const winSec = 4;
    let tone = { freq: 0, mag: 0 };
    let tonePos = 0;
    for (let pos = 0; pos + winSec * fs <= headLen; pos += Math.floor(fs)) {
        const s = avgSpectrum(x, fs, pos, Math.floor(winSec * fs));
        const cand = strongestNarrowPeak(s.mag, s.binHz, 100, 16000, [[40, 70], [90, 130], [140, 190]]);
        if (cand.mag > tone.mag) {
            tone = cand;
            tonePos = pos;
        }
    }
    let toneFreq = 0;
    let toneDb = -Infinity;
    if (tone.freq > 0) {
        toneFreq = refineFrequency(x, fs, tone.freq, tonePos, Math.floor(winSec * fs));
        toneDb = toDb(tone.mag, 8192);
    }
    // 全带前 humSeconds:找哼声并精化
    const humLen = Math.min(x.length, Math.floor(humSeconds * fs));
    const whole = avgSpectrum(x, fs, 0, humLen);
    const hum = humPeak(whole.mag, whole.binHz);
    const humDb = hum.mag > 0 ? toDb(hum.mag, whole.winLen) : -Infinity;
    let humFreq = 0;
    if (humDb > -75) {
        humFreq = refineFrequency(x, fs, hum.freq, 0, humLen);
    }
    if (toneFreq > 0) {
        return { type: 'tone', toneFreq, humFreq, primary: toneFreq, levelDb: toneDb };
    }
    if (humFreq > 0) {
        return { type: 'hum', toneFreq: 0, humFreq, primary: humFreq, levelDb: humDb };
    }
    return none;
}
