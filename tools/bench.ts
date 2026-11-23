// 性能验收:60 分钟磁带处理时间 ≤ 2 分钟。
// 用法: node dist/tools/bench.js [分钟]   默认 60

import { synthesize } from './synth.js';
import { restore } from '../src/dsp/pipeline.js';

const minutes = Number(process.argv[2] ?? 60);
const durationSec = minutes * 60;
console.log(`合成 ${minutes} 分钟测试带...`);
const t0 = performance.now();
const tape = synthesize({
  durationSec, toneSec: 10,
  wowAmp: 0.008, wowHz: 0.7, flutterAmp: 0.002, flutterHz: 8,
  driftAmp: 0.001, azimuthArcmin: 8, seed: 99,
});
const tSynth = performance.now() - t0;
console.log(`合成耗时 ${(tSynth / 1000).toFixed(1)}s,样本数 ${(tape.L.length / 1e6).toFixed(1)}M/声道`);

console.log('开始修复处理...');
const t1 = performance.now();
const res = restore(tape.L, tape.R, tape.fs);
const tProc = performance.now() - t1;

console.log(`\n处理耗时: ${(tProc / 1000).toFixed(1)}s(指标: 60 分钟 ≤ 120s)`);
console.log('分阶段耗时(ms):');
for (const [k, v] of Object.entries(res.timings)) {
  console.log(`  ${k.padEnd(18)} ${v.toFixed(0)}`);
}
console.log(`\n方位角估计: ${res.azimuth.angleArcmin.toFixed(2)} 角分(真值 8.0)`);
console.log(`残余抖晃: ${(res.residualWowFlutter * 100).toFixed(3)}%`);
const ratio = tProc / 1000 / durationSec;
console.log(`处理速度: ${(1 / ratio).toFixed(1)}x 实时`);
const scaled = (tProc / 1000) * (60 / minutes);
console.log(`折算 60 分钟: ${scaled.toFixed(1)}s ${scaled <= 120 ? '✓ 达标' : '✗ 超标'}`);
process.exit(scaled <= 120 ? 0 : 1);
