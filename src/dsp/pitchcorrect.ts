// 音高校正:按测得的速度偏差曲线做时变重采样,把音调拉正。
// 转录模型:x[i] = s(φ(i)),φ' = 1+ε(带速偏快 → 音调偏高)。
// 还原要求读位置按 ψ' = 1/(1+ε) 步进(ψ = φ 的反函数)。
// 插值用 8 抽头窗 sinc 查找表,10kHz 处不引入附加滚降。

import { sincInterpAt, cubicAt } from './interp.js';

export { cubicAt };

/**
 * 单通道时变重采样。
 * @param x   输入
 * @param eps 速度偏差曲线(控制率,按输入样本位置索引)
 * @param hop 控制点间隔(样本)
 */
export function resampleVariable(x: Float32Array, eps: Float32Array, hop: number): Float32Array {
  const out = new Float32Array(Math.min(x.length * 2, x.length + Math.ceil(x.length * 0.2) + 1024));
  const nPoints = eps.length;
  let pos = 3;
  let outIdx = 0;
  const limit = x.length - 6;
  while (pos < limit && outIdx < out.length) {
    const p = Math.min(nPoints - 1, (pos / hop) | 0);
    out[outIdx++] = sincInterpAt(x, pos);
    pos += 1 / (1 + eps[p]);
  }
  return out.subarray(0, outIdx) as Float32Array;
}

/** 立体声:两通道共用同一条位置轨迹,保持声道间相对关系。 */
export function resampleVariableStereo(
  L: Float32Array,
  R: Float32Array,
  eps: Float32Array,
  hop: number
): { L: Float32Array; R: Float32Array } {
  const out = new Float32Array(Math.min(L.length * 2, L.length + Math.ceil(L.length * 0.2) + 1024));
  const outL = new Float32Array(out.length);
  const outR = new Float32Array(out.length);
  const nPoints = eps.length;
  let pos = 3;
  let outIdx = 0;
  const limit = Math.min(L.length, R.length) - 6;
  while (pos < limit && outIdx < out.length) {
    const p = Math.min(nPoints - 1, (pos / hop) | 0);
    outL[outIdx] = sincInterpAt(L, pos);
    outR[outIdx] = sincInterpAt(R, pos);
    outIdx++;
    pos += 1 / (1 + eps[p]);
  }
  return {
    L: outL.subarray(0, outIdx) as Float32Array,
    R: outR.subarray(0, outIdx) as Float32Array,
  };
}
