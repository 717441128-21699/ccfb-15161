// 高频补偿:按估计的方位角设计 sinc 损耗的逆滤波器(限幅防深零反演),
// 频域采样 + IFFT 得到线性相位 FIR,用 FFT 卷积快速施加。
import { fft, fftConvolve } from './fft.js';
import { azimuthLossDb, CASSETTE_PARAMS } from './azimuth.js';
/** 设计方位角补偿 FIR。 */
export function designAzimuthEq(angleRad, fs, params = CASSETTE_PARAMS, maxGainDb = 24, numTaps = 255) {
    const nfft = 4096;
    const gain = new Float64Array(nfft);
    const maxLin = Math.pow(10, maxGainDb / 20);
    for (let k = 0; k < nfft / 2; k++) {
        const f = (k * fs) / nfft;
        const lossDb = azimuthLossDb(f, angleRad, params); // 负值
        let g = Math.pow(10, -lossDb / 20); // 逆响应
        if (!isFinite(g) || g > maxLin)
            g = maxLin;
        gain[k] = g;
        gain[nfft - 1 - k] = g; // 共轭对称(实数偶对称)
    }
    const re = Float64Array.from(gain);
    const im = new Float64Array(nfft);
    fft(re, im, true); // IFFT -> 冲激响应(中心在 0)
    // 循环移位到线性相位中心并加窗
    const half = (numTaps - 1) / 2;
    const taps = new Float32Array(numTaps);
    for (let i = 0; i < numTaps; i++) {
        const idx = ((i - half) + nfft) % nfft;
        // Hann 窗
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (numTaps - 1));
        taps[i] = re[idx] * w;
    }
    const lossDbAt10k = azimuthLossDb(10000, angleRad, params);
    // 实际补偿后残差 = 损耗 + 滤波器在 10kHz 的实际响应
    const resp = firResponseDb(taps, 10000, fs);
    const residualDbAt10k = lossDbAt10k + resp;
    return { taps, lossDbAt10k, residualDbAt10k, maxGainDb };
}
/** FIR 在指定频率的响应(dB) */
export function firResponseDb(taps, freqHz, fs) {
    const w = (2 * Math.PI * freqHz) / fs;
    let re = 0, im = 0;
    for (let i = 0; i < taps.length; i++) {
        re += taps[i] * Math.cos(w * i);
        im -= taps[i] * Math.sin(w * i);
    }
    return 20 * Math.log10(Math.max(1e-9, Math.hypot(re, im)));
}
/** 对立体声施加补偿滤波(FFT 卷积,长录音也很快)。 */
export function applyEqStereo(L, R, taps) {
    return { L: fftConvolve(L, taps), R: fftConvolve(R, taps) };
}
/** 测量信号在某频率的电平相对参考信号的 dB 差(用于验收 10kHz 响应)。 */
export function measureResponseDb(test, reference, fs, freqHz, start, len) {
    // 内联 Goertzel,避免循环依赖
    const amp = (x) => {
        const n = Math.min(len, x.length - start);
        if (n <= 0)
            return 0;
        const w = (2 * Math.PI * freqHz) / fs;
        const cw = 2 * Math.cos(w);
        let s0 = 0, s1 = 0, s2 = 0;
        for (let i = 0; i < n; i++) {
            s0 = x[start + i] + cw * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        return (2 * Math.sqrt(Math.max(s1 * s1 + s2 * s2 - cw * s1 * s2, 0))) / n;
    };
    const a = amp(test);
    const b = amp(reference);
    if (a <= 0 || b <= 0)
        return NaN;
    return 20 * Math.log10(a / b);
}
