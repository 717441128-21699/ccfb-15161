// 方位角估计:左右声道高频互谱相位斜率 -> 声道间时差 -> 磁头方位角。
// 物理关系:Δt = S·tanθ / v(S 为两声道磁迹中心距,v 为带速)。
// 单条磁迹的高频损耗:H(f) = sinc(π·W·tanθ·f / v),W 为磁迹宽度。
import { rfft } from './fft.js';
import { sincInterpAt } from './interp.js';
export const CASSETTE_PARAMS = {
    tapeSpeedMms: 47.625,
    trackSpacingMm: 0.9,
    trackWidthMm: 0.6,
};
/** 二阶 Butterworth 高通(双声道就地) */
function highPass_inplace(x, fs, fc) {
    const w = Math.tan((Math.PI * fc) / fs);
    const k = w * w;
    const norm = 1 / (1 + Math.SQRT1_2 * 2 * w + k);
    const b0 = norm, b1 = -2 * norm, b2 = norm;
    const a1 = 2 * (k - 1) * norm, a2 = (1 - Math.SQRT1_2 * 2 * w + k) * norm;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
        const x0 = x[i];
        const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x0;
        y2 = y1;
        y1 = y0;
        x[i] = y0;
    }
}
/**
 * 估计左右声道时差与方位角。
 * 在整盘磁带上均匀取窗,累积互谱后做相位-频率加权线性拟合。
 */
export function estimateAzimuth(L, R, fs, params = CASSETTE_PARAMS, bandLowHz = 4000, bandHighHz = 16000) {
    const n = Math.min(L.length, R.length);
    const winLen = 4096;
    // 均匀分布的窗,最多 400 个,覆盖全带
    const maxWindows = 400;
    const totalFit = Math.max(1, Math.floor((n - winLen) / winLen));
    const nWin = Math.min(maxWindows, totalFit);
    const stride = Math.max(1, Math.floor(totalFit / nWin));
    const lb = L.slice(0, n);
    const rb = R.slice(0, n);
    highPass_inplace(lb, fs, bandLowHz * 0.7);
    highPass_inplace(rb, fs, bandLowHz * 0.7);
    const hann = new Float64Array(winLen);
    for (let i = 0; i < winLen; i++)
        hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / winLen);
    const crossRe = new Float64Array(winLen / 2);
    const crossIm = new Float64Array(winLen / 2);
    const frameL = new Float32Array(winLen);
    const frameR = new Float32Array(winLen);
    for (let w = 0; w < nWin; w++) {
        const pos = w * stride * winLen;
        if (pos + winLen > n)
            break;
        for (let i = 0; i < winLen; i++) {
            frameL[i] = lb[pos + i] * hann[i];
            frameR[i] = rb[pos + i] * hann[i];
        }
        const XL = rfft(frameL, winLen);
        const XR = rfft(frameR, winLen);
        for (let k = 0; k < winLen / 2; k++) {
            // conj(XL)·XR
            crossRe[k] += XL.re[k] * XR.re[k] + XL.im[k] * XR.im[k];
            crossIm[k] += XL.re[k] * XR.im[k] - XL.im[k] * XR.re[k];
        }
    }
    const binHz = fs / winLen;
    const kLo = Math.max(1, Math.round(bandLowHz / binHz));
    const kHi = Math.min(winLen / 2 - 1, Math.round(Math.min(bandHighHz, fs / 2 - 100) / binHz));
    // 相位展开(相邻 bin 相位步进很小,直接展开)
    const phase = new Float64Array(kHi - kLo + 1);
    const weight = new Float64Array(kHi - kLo + 1);
    let prev = Math.atan2(crossIm[kLo], crossRe[kLo]);
    phase[0] = prev;
    weight[0] = Math.hypot(crossRe[kLo], crossIm[kLo]);
    for (let k = kLo + 1; k <= kHi; k++) {
        let p = Math.atan2(crossIm[k], crossRe[k]);
        let d = p - prev;
        while (d > Math.PI) {
            p -= 2 * Math.PI;
            d -= 2 * Math.PI;
        }
        while (d < -Math.PI) {
            p += 2 * Math.PI;
            d += 2 * Math.PI;
        }
        phase[k - kLo] = phase[k - kLo - 1] + d;
        weight[k - kLo] = Math.hypot(crossRe[k], crossIm[k]);
        prev = p;
    }
    // 加权线性拟合 phase = slope·f + c
    let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
    for (let i = 0; i < phase.length; i++) {
        const f = (kLo + i) * binHz;
        const w = weight[i] * weight[i];
        sw += w;
        swx += w * f;
        swy += w * phase[i];
        swxx += w * f * f;
        swxy += w * f * phase[i];
    }
    const denom = sw * swxx - swx * swx;
    const slope = Math.abs(denom) > 1e-20 ? (sw * swxy - swx * swy) / denom : 0;
    // conj(XL)·XR 的相位 = -ω·dt(dt 为 R 相对 L 的滞后),故取负
    const dt = -slope / (2 * Math.PI); // 秒;正 = R 滞后 L
    const angleRad = Math.atan((dt * params.tapeSpeedMms) / params.trackSpacingMm);
    return { dtSeconds: dt, angleRad, angleArcmin: (angleRad * 180 * 60) / Math.PI };
}
/** 方位角损耗(dB,负值):H(f)=sinc(π·W·tanθ·f/v) */
export function azimuthLossDb(freqHz, angleRad, params = CASSETTE_PARAMS) {
    const x = (Math.PI * params.trackWidthMm * Math.tan(angleRad) * freqHz) / params.tapeSpeedMms;
    if (Math.abs(x) < 1e-9)
        return 0;
    const s = Math.sin(x) / x;
    return 20 * Math.log10(Math.max(1e-6, Math.abs(s)));
}
/** 对信号做分数样本延时(d 可为负,单位:样本)。 */
export function fractionalDelay(x, d) {
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
        const pos = i - d;
        out[i] = pos >= 3 && pos < x.length - 5 ? sincInterpAt(x, pos) : 0;
    }
    return out;
}
/** 按测得的时差对齐声道:dt>0(R 滞后)时把 L 延后 dt。 */
export function alignChannels(L, R, fs, dtSeconds) {
    const d = dtSeconds * fs;
    if (Math.abs(d) < 0.01)
        return { L, R };
    if (d > 0)
        return { L: fractionalDelay(L, d), R };
    return { L, R: fractionalDelay(R, -d) };
}
