// 抖晃跟踪:正交解调参考音,相位微分得到瞬时频偏 -> 速度偏差 ε(t)。
// 基带低通用四阶 Butterworth:混频镜像(2·f0)抑制不足会在相位拟合里漏成野值。
// 支持主/备双参考(带首对位音 + 全程哼声):主参考电平不足的段落自动切备参考。
// WowTracker 类同时被离线管线和 AudioWorklet(实时)复用。
/** 四阶低通(两级 Butterworth 双二阶级联),用于 I/Q 基带 */
export class Lowpass4 {
    s;
    b;
    a;
    constructor(fs, cutoffHz) {
        // 两级 Q=0.5412 / 1.3065 的 Butterworth 双二阶
        const stages = [0.54119610, 1.30656296];
        this.b = new Float64Array(stages.length * 3);
        this.a = new Float64Array(stages.length * 2);
        this.s = new Float64Array(stages.length * 4); // x1,x2,y1,y2 per stage
        stages.forEach((q, st) => {
            const w0 = (2 * Math.PI * cutoffHz) / fs;
            const cw = Math.cos(w0), sw = Math.sin(w0);
            const alpha = sw / (2 * q);
            const a0 = 1 + alpha;
            this.b[st * 3] = ((1 - cw) / 2) / a0;
            this.b[st * 3 + 1] = (1 - cw) / a0;
            this.b[st * 3 + 2] = ((1 - cw) / 2) / a0;
            this.a[st * 2] = (-2 * cw) / a0;
            this.a[st * 2 + 1] = (1 - alpha) / a0;
        });
    }
    process(x) {
        let y = x;
        for (let st = 0; st < 2; st++) {
            const o = st * 4;
            const y0 = this.b[st * 3] * y + this.b[st * 3 + 1] * this.s[o] + this.b[st * 3 + 2] * this.s[o + 1]
                - this.a[st * 2] * this.s[o + 2] - this.a[st * 2 + 1] * this.s[o + 3];
            this.s[o + 1] = this.s[o];
            this.s[o] = y;
            this.s[o + 3] = this.s[o + 2];
            this.s[o + 2] = y0;
            y = y0;
        }
        return y;
    }
}
export class WowTracker {
    phase = 0;
    dPhase;
    lpI;
    lpQ;
    iLP = 0;
    qLP = 0;
    prevPhaseBB = 0;
    hasPrev = false;
    epsSmooth = 0;
    epsAlpha;
    fs;
    f0;
    constructor(f0, fs, cutoffHz = 30, epsSmoothHz = 15) {
        this.f0 = f0;
        this.fs = fs;
        this.dPhase = (2 * Math.PI * f0) / fs;
        this.lpI = new Lowpass4(fs, cutoffHz);
        this.lpQ = new Lowpass4(fs, cutoffHz);
        this.epsAlpha = 1 - Math.exp((-2 * Math.PI * epsSmoothHz) / fs);
    }
    /** 处理一个样本,返回平滑后的速度偏差 ε(相对值,如 0.005 = 0.5%) */
    processSample(x) {
        const c = Math.cos(this.phase);
        const s = Math.sin(this.phase);
        this.phase += this.dPhase;
        if (this.phase > Math.PI)
            this.phase -= 2 * Math.PI;
        this.iLP = this.lpI.process(x * c);
        this.qLP = this.lpQ.process(-x * s);
        const ph = Math.atan2(this.qLP, this.iLP);
        let eps = this.epsSmooth;
        if (this.hasPrev) {
            let d = ph - this.prevPhaseBB;
            if (d > Math.PI)
                d -= 2 * Math.PI;
            else if (d < -Math.PI)
                d += 2 * Math.PI;
            const inst = (d * this.fs) / (2 * Math.PI * this.f0);
            const clamped = Math.max(-0.1, Math.min(0.1, inst));
            eps = this.epsSmooth + this.epsAlpha * (clamped - this.epsSmooth);
            this.epsSmooth = eps;
        }
        this.prevPhaseBB = ph;
        this.hasPrev = true;
        return eps;
    }
    /** 当前参考音基带幅度(用于置信度门控) */
    amplitude() {
        return 2 * Math.hypot(this.iLP, this.qLP);
    }
}
/**
 * 离线整段跟踪:每控制块对正交基带相位做最小二乘斜率拟合,
 * 直接得到该块的平均速度偏差。低置信段用邻近有效值填充。
 * @param f0 主参考频率(通常是对位音)
 * @param f0Fallback 备用参考频率(通常是哼声),0 = 不用
 */
export function trackDeviation(x, fs, f0, hop = 512, cutoffHz = 30, f0Fallback = 0) {
    const nPoints = Math.ceil(x.length / hop);
    const eps = new Float32Array(nPoints);
    const valid = new Uint8Array(nPoints);
    const source = new Uint8Array(nPoints);
    // 单参考的块估计
    const track1 = (fRef, lpHz) => {
        const e = new Float32Array(nPoints);
        const a = new Float32Array(nPoints);
        const dPh = (2 * Math.PI * fRef) / fs;
        const lpI = new Lowpass4(fs, lpHz);
        const lpQ = new Lowpass4(fs, lpHz);
        const dec = 8;
        const perBlock = Math.ceil(hop / dec);
        const phases = new Float64Array(perBlock + 1);
        let osc = 0, iLP = 0, qLP = 0;
        for (let p = 0; p < nPoints; p++) {
            const start = p * hop;
            const m = Math.min(hop, x.length - start);
            let k = 0, ampAcc = 0;
            for (let i = 0; i < m; i++) {
                const c = Math.cos(osc), s = Math.sin(osc);
                osc += dPh;
                if (osc > Math.PI)
                    osc -= 2 * Math.PI;
                const v = x[start + i];
                iLP = lpI.process(v * c);
                qLP = lpQ.process(-v * s);
                if (i % dec === 0) {
                    phases[k++] = Math.atan2(qLP, iLP);
                    ampAcc += Math.hypot(iLP, qLP);
                }
            }
            a[p] = k > 0 ? (2 * ampAcc) / k : 0;
            if (k > 4) {
                let off = 0;
                for (let i = 1; i < k; i++) {
                    let d = phases[i] + off - phases[i - 1];
                    if (d > Math.PI)
                        off -= 2 * Math.PI;
                    else if (d < -Math.PI)
                        off += 2 * Math.PI;
                    phases[i] += off;
                }
                let sx = 0, sy = 0, sxx = 0, sxy = 0;
                const dt = dec / fs;
                for (let i = 0; i < k; i++) {
                    const t = i * dt;
                    sx += t;
                    sy += phases[i];
                    sxx += t * t;
                    sxy += t * phases[i];
                }
                const denom = k * sxx - sx * sx;
                const slope = Math.abs(denom) > 1e-12 ? (k * sxy - sx * sy) / denom : 0;
                e[p] = slope / (2 * Math.PI * fRef);
            }
        }
        return { e, a };
    };
    const pri = track1(f0, cutoffHz);
    const useFallback = f0Fallback > 0 && Math.abs(f0Fallback - f0) > 1;
    const fb = useFallback ? track1(f0Fallback, Math.min(cutoffHz, f0Fallback * 0.25)) : null;
    // 电平门限:峰值的一定比例之下视为参考缺失
    const thrOf = (amp) => {
        let mx = 0;
        for (let i = 0; i < amp.length; i++)
            if (amp[i] > mx)
                mx = amp[i];
        return Math.max(mx * 0.25, 1e-5);
    };
    const thrP = thrOf(pri.a);
    const thrF = fb ? thrOf(fb.a) : Infinity;
    // 前 0.2s 滤波器未稳定,标记无效
    const settle = Math.min(nPoints, Math.ceil((0.2 * fs) / hop));
    for (let p = 0; p < nPoints; p++) {
        const okP = p >= settle && pri.a[p] >= thrP;
        const okF = fb !== null && p >= settle && fb.a[p] >= thrF;
        if (okP) {
            eps[p] = pri.e[p];
            valid[p] = 1;
            source[p] = 1;
        }
        else if (okF) {
            eps[p] = fb.e[p];
            valid[p] = 1;
            source[p] = 2;
        }
    }
    // 无效段:用前后有效值线性插值;两端用最近有效值
    let firstValid = -1, lastValid = -1;
    for (let p = 0; p < nPoints; p++)
        if (valid[p]) {
            if (firstValid < 0)
                firstValid = p;
            lastValid = p;
        }
    if (firstValid >= 0) {
        for (let p = 0; p < firstValid; p++)
            eps[p] = eps[firstValid];
        for (let p = lastValid + 1; p < nPoints; p++)
            eps[p] = eps[lastValid];
        let p = firstValid;
        while (p < nPoints) {
            if (valid[p]) {
                p++;
                continue;
            }
            let q = p;
            while (q < nPoints && !valid[q])
                q++;
            const a = eps[p - 1], b = q < nPoints ? eps[q] : a;
            for (let k = p; k < q; k++)
                eps[k] = a + ((b - a) * (k - p + 1)) / (q - p + 1);
            p = q;
        }
    }
    else {
        eps.fill(0);
    }
    // 轻度平滑(三点 [0.25 0.5 0.25]):抑制跟踪噪声,对 wow/flutter 带宽影响很小
    if (nPoints > 4) {
        const sm = Float32Array.from(eps);
        for (let p = 1; p < nPoints - 1; p++) {
            sm[p] = 0.25 * eps[p - 1] + 0.5 * eps[p] + 0.25 * eps[p + 1];
        }
        eps.set(sm);
    }
    return { eps, hop, valid, source };
}
