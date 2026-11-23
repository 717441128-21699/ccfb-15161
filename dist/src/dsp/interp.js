// 高质量分数延时插值:8 抽头布莱克曼窗 sinc,512 相查找表。
// 通带到 ~0.45·fs 平坦(<0.05dB),时变重采样不会在 10kHz 处引入附加滚降。
const PHASES = 512;
const TAPS = 8;
const HALF = TAPS / 2; // 4
function sinc(x) {
    if (Math.abs(x) < 1e-9)
        return 1;
    const p = Math.PI * x;
    return Math.sin(p) / p;
}
function blackman(x) {
    // x ∈ [-1, 1]
    return 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);
}
const table = new Float32Array((PHASES + 1) * TAPS);
for (let p = 0; p <= PHASES; p++) {
    const f = p / PHASES;
    let sum = 0;
    for (let k = 0; k < TAPS; k++) {
        const d = k - (HALF - 1) - f; // 中心在 HALF-1
        const h = sinc(d) * blackman(d / HALF);
        table[p * TAPS + k] = h;
        sum += h;
    }
    // 归一化直流增益
    for (let k = 0; k < TAPS; k++)
        table[p * TAPS + k] /= sum;
}
/** 在分数位置 pos 处插值。边界外返回 0 由调用方保证 pos ∈ [3, len-5]。 */
export function sincInterpAt(x, pos) {
    const i = Math.floor(pos);
    const f = pos - i;
    const p = Math.round(f * PHASES);
    const o = p * TAPS;
    const b = i - (HALF - 1);
    let y = 0;
    for (let k = 0; k < TAPS; k++)
        y += table[o + k] * x[b + k];
    return y;
}
/** Catmull-Rom 三次插值(轻量场景用) */
export function cubicAt(x, pos) {
    const i = Math.floor(pos);
    const f = pos - i;
    const i0 = Math.max(0, i - 1);
    const i1 = Math.max(0, i);
    const i2 = Math.min(x.length - 1, i + 1);
    const i3 = Math.min(x.length - 1, i + 2);
    const a = x[i0], b = x[i1], c = x[i2], d = x[i3];
    return (b +
        0.5 *
            f *
            (c - a + f * (2 * a - 5 * b + 4 * c - d + f * (3 * (b - c) + d - a))));
}
