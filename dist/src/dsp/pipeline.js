// 修复处理管线:参考音检测 -> 抖晃跟踪 -> 音高校正 -> 方位角估计 -> 声道对齐 -> 高频补偿。
// 全程在 Float32 数组上离线处理(60 分钟磁带目标 < 2 分钟),Node 与浏览器 Worker 通用。
import { detectReference } from './reference.js';
import { trackDeviation } from './wowtrack.js';
import { resampleVariableStereo } from './pitchcorrect.js';
import { estimateAzimuth, alignChannels, CASSETTE_PARAMS, } from './azimuth.js';
import { designAzimuthEq, applyEqStereo } from './hfeq.js';
export function restore(Lin, Rin, fs, opts = {}) {
    const params = opts.azimuthParams ?? CASSETTE_PARAMS;
    const timings = {};
    const t0 = nowMs();
    const tick = (name, since) => { timings[name] = nowMs() - since; };
    const progress = (f, s) => opts.onProgress?.(f, s);
    // 1. 参考音/哼声检测(用左声道带首)
    progress(0.02, '检测参考音');
    let t = nowMs();
    const reference = detectReference(Lin, fs, 30);
    tick('detectReference', t);
    if (reference.type === 'none')
        throw new Error('未找到参考音或交流哼声,无法跟踪抖晃');
    // 2. 抖晃跟踪(左右混音后跟踪,减少一半计算;对位音缺失段用哼声接力)
    progress(0.08, '跟踪抖晃');
    t = nowMs();
    const mono = new Float32Array(Math.min(Lin.length, Rin.length));
    for (let i = 0; i < mono.length; i++)
        mono[i] = 0.5 * (Lin[i] + Rin[i]);
    const fallback = reference.humFreq > 0 && Math.abs(reference.humFreq - reference.primary) > 1
        ? reference.humFreq : 0;
    const deviation = trackDeviation(mono, fs, reference.primary, 512, 30, fallback);
    tick('trackDeviation', t);
    // 3. 音高校正(时变重采样)
    progress(0.35, '音高校正');
    t = nowMs();
    const pitched = resampleVariableStereo(Lin, Rin, deviation.eps, deviation.hop);
    tick('pitchCorrect', t);
    // 4. 方位角估计
    progress(0.6, '估计方位角');
    t = nowMs();
    const azimuth = estimateAzimuth(pitched.L, pitched.R, fs, params);
    tick('estimateAzimuth', t);
    // 5. 声道对齐
    progress(0.7, '声道对齐');
    t = nowMs();
    const aligned = alignChannels(pitched.L, pitched.R, fs, azimuth.dtSeconds);
    tick('alignChannels', t);
    // 6. 高频补偿
    progress(0.78, '高频补偿');
    t = nowMs();
    const eq = designAzimuthEq(azimuth.angleRad, fs, params, opts.maxEqGainDb ?? 24);
    const eqd = applyEqStereo(aligned.L, aligned.R, eq.taps);
    tick('applyEq', t);
    // 7. 残余抖晃(校正后再跟踪一次参考音)
    progress(0.92, '校验残余抖晃');
    t = nowMs();
    const mono2 = new Float32Array(eqd.L.length);
    for (let i = 0; i < mono2.length; i++)
        mono2[i] = 0.5 * (eqd.L[i] + eqd.R[i]);
    const res = trackDeviation(mono2, fs, reference.primary, 2048, 30, fallback);
    let sum = 0, cnt = 0;
    for (let i = 0; i < res.eps.length; i++) {
        if (res.valid[i]) {
            sum += res.eps[i] * res.eps[i];
            cnt++;
        }
    }
    const residualWowFlutter = cnt > 0 ? Math.sqrt(sum / cnt) : 0;
    tick('verify', t);
    progress(1, '完成');
    timings.total = nowMs() - t0;
    return {
        L: eqd.L, R: eqd.R, sampleRate: fs,
        reference, deviation, azimuth, eq, residualWowFlutter, timings,
    };
}
function nowMs() {
    // Node 与浏览器都有 performance
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
