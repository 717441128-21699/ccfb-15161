// 验收测试:合成多组抖晃 × 方位角偏差的测试带,跑修复管线,检查:
//   1) 方位角估计误差 ≤ 2 角分
//   2) 高频补偿后 10kHz 响应与参考带相差 ≤ 1 dB
//   3) 报告残余抖晃与处理耗时

import { synthesize, SynthOptions } from './synth.js';
import { restore } from '../src/dsp/pipeline.js';
import { rfft } from '../src/dsp/fft.js';

/**
 * 校准音电平测量:对每 1s 窗求 9.5–10.5kHz 频带能量,取最大窗。
 * 用频带总能量而非单频幅度——残余抖晃只会把音在频带内扫,不会损失频带能量,
 * 这样测到的才是高频响应(EQ)本身。
 */
function bandLevel(x: Float32Array, fs: number, fLo = 9500, fHi = 10500): number {
  const win = Math.floor(1 * fs);
  const hop = Math.floor(0.5 * fs);
  const nfft = 8192;
  const frame = new Float32Array(win);
  let best = 0;
  for (let s = 0; s + win <= x.length; s += hop) {
    for (let i = 0; i < win; i++) frame[i] = x[s + i];
    const { re, im } = rfft(frame, nfft);
    const binHz = fs / nfft;
    let p = 0;
    for (let k = Math.round(fLo / binHz); k <= Math.round(fHi / binHz); k++) {
      p += re[k] * re[k] + im[k] * im[k];
    }
    if (p > best) best = p;
  }
  return Math.sqrt(best);
}

interface Scenario { name: string; opts: SynthOptions }

const scenarios: Scenario[] = [
  { name: '轻微抖晃+2角分', opts: { wowAmp: 0.003, wowHz: 0.8, flutterAmp: 0.0008, flutterHz: 6, driftAmp: 0.0005, azimuthArcmin: 2, seed: 11 } },
  { name: '中等抖晃+5角分', opts: { wowAmp: 0.007, wowHz: 0.6, flutterAmp: 0.0015, flutterHz: 8, driftAmp: 0.001, azimuthArcmin: 5, seed: 22 } },
  { name: '严重抖晃+10角分', opts: { wowAmp: 0.012, wowHz: 1.1, flutterAmp: 0.003, flutterHz: 10, driftAmp: 0.002, azimuthArcmin: 10, seed: 33 } },
  { name: '中等抖晃+15角分', opts: { wowAmp: 0.006, wowHz: 0.5, flutterAmp: 0.001, flutterHz: 5, driftAmp: 0.001, azimuthArcmin: 15, seed: 44 } },
  { name: '重flutter+7角分', opts: { wowAmp: 0.004, wowHz: 0.9, flutterAmp: 0.004, flutterHz: 12, driftAmp: 0.001, azimuthArcmin: 7, seed: 55 } },
];

let allPass = true;
console.log('场景                | 方位角(真值/估计/误差,角分) | 10kHz响应差(dB) | 残余抖晃% | 耗时ms');
console.log('-'.repeat(105));

for (const sc of scenarios) {
  const tape = synthesize(sc.opts);
  const t0 = performance.now();
  const res = restore(tape.L, tape.R, tape.fs);
  const elapsed = performance.now() - t0;

  // 指标 1:方位角估计误差
  const azErr = Math.abs(res.azimuth.angleArcmin - tape.trueAzimuthArcmin);
  const azPass = azErr <= 2;

  // 指标 2:10kHz 响应(校正后 vs 参考带,频带能量法)
  const ampCorr = bandLevel(res.L, tape.fs);
  const ampRef = bandLevel(tape.refL, tape.fs);
  const respDb = 20 * Math.log10(ampCorr / ampRef);
  const respPass = Math.abs(respDb) <= 1;

  const wf = res.residualWowFlutter * 100;
  const pass = azPass && respPass;
  allPass = allPass && pass;
  console.log(
    `${sc.name.padEnd(18)}| ${tape.trueAzimuthArcmin.toFixed(1).padStart(5)} / ${res.azimuth.angleArcmin.toFixed(2).padStart(6)} / ${azErr.toFixed(2).padStart(5)} ${azPass ? '✓' : '✗'}      | ${respDb.toFixed(2).padStart(6)} ${respPass ? '✓' : '✗'}       | ${wf.toFixed(3).padStart(6)}  | ${elapsed.toFixed(0)}`
  );
}

console.log('-'.repeat(105));
console.log(allPass ? '全部通过 ✓' : '存在未通过项 ✗');
process.exit(allPass ? 0 : 1);
