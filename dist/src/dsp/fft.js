// 迭代基-2 FFT(复数,就地),以及实信号辅助函数。
// 纯 TypeScript,无 DOM 依赖,浏览器 / AudioWorklet / Node 通用。
export function nextPow2(n) {
    let p = 1;
    while (p < n)
        p <<= 1;
    return p;
}
/** 就地复数 FFT。re/im 长度必须为 2 的幂。inverse=true 时做逆变换并除以 N。 */
export function fft(re, im, inverse) {
    const n = re.length;
    // 位反转重排
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1)
            j ^= bit;
        j ^= bit;
        if (i < j) {
            let t = re[i];
            re[i] = re[j];
            re[j] = t;
            t = im[i];
            im[i] = im[j];
            im[j] = t;
        }
    }
    const sign = inverse ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (sign * 2 * Math.PI) / len;
        const wr = Math.cos(ang), wi = Math.sin(ang);
        const half = len >> 1;
        for (let i = 0; i < n; i += len) {
            let cwr = 1, cwi = 0;
            for (let j = 0; j < half; j++) {
                const ur = re[i + j], ui = im[i + j];
                const vr = re[i + j + half] * cwr - im[i + j + half] * cwi;
                const vi = re[i + j + half] * cwi + im[i + j + half] * cwr;
                re[i + j] = ur + vr;
                im[i + j] = ui + vi;
                re[i + j + half] = ur - vr;
                im[i + j + half] = ui - vi;
                const nwr = cwr * wr - cwi * wi;
                cwi = cwr * wi + cwi * wr;
                cwr = nwr;
            }
        }
    }
    if (inverse) {
        for (let i = 0; i < n; i++) {
            re[i] /= n;
            im[i] /= n;
        }
    }
}
/** 实信号 FFT,返回 {re, im}(长度 n,n 自动补零到 2 的幂)。 */
export function rfft(x, n) {
    const N = n ?? nextPow2(x.length);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const m = Math.min(x.length, N);
    for (let i = 0; i < m; i++)
        re[i] = x[i];
    fft(re, im, false);
    return { re, im };
}
/**
 * 重叠保留法 FFT 卷积:x * h(h 为 FIR,线性相位或任意)。
 * 用于长信号的快速滤波(60 分钟磁带在秒级完成)。
 */
export function fftConvolve(x, h) {
    const M = h.length;
    const segLen = 8192; // 每段输入长度
    const N = nextPow2(segLen + M - 1);
    const out = new Float32Array(x.length + M - 1);
    const hre = new Float64Array(N);
    const him = new Float64Array(N);
    for (let i = 0; i < M; i++)
        hre[i] = h[i];
    fft(hre, him, false);
    const xre = new Float64Array(N);
    const xim = new Float64Array(N);
    for (let pos = 0; pos < x.length; pos += segLen) {
        xre.fill(0);
        xim.fill(0);
        const m = Math.min(segLen, x.length - pos);
        for (let i = 0; i < m; i++)
            xre[i] = x[pos + i];
        fft(xre, xim, false);
        for (let i = 0; i < N; i++) {
            const ar = xre[i], ai = xim[i];
            xre[i] = ar * hre[i] - ai * him[i];
            xim[i] = ar * him[i] + ai * hre[i];
        }
        fft(xre, xim, true);
        const valid = Math.min(N, x.length + M - 1 - pos);
        for (let i = 0; i < valid; i++)
            out[pos + i] += xre[i];
    }
    return out.subarray(0, x.length);
}
/** Goertzel:测单频幅度(用于 10kHz 响应测量等)。返回幅度(峰值,相对满幅 1.0)。 */
export function goertzelAmp(x, fs, freq, start = 0, len = 0) {
    const n = len > 0 ? Math.min(len, x.length - start) : x.length - start;
    if (n <= 0)
        return 0;
    const w = (2 * Math.PI * freq) / fs;
    const cw = 2 * Math.cos(w);
    let s0 = 0, s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
        s0 = x[start + i] + cw * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - cw * s1 * s2;
    return (2 * Math.sqrt(Math.max(power, 0))) / n;
}
