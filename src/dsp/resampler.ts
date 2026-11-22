import type { DriftPoint } from './types';
import { sampleRatioAt } from './wow-flutter';

/**
 * 流式变速重采样器。
 *
 * 输入是录进来的"带抖晃"信号 x[n]（n 按录音采样率），
 * 测量得到瞬时速度比 s(t)=带速/额定带速，即输入相对输出的采样率比。
 * 校正后的输出位置 p 处取输入位置 q(p)=q0+∫s dt，
 * 用 4 点 Catmull-Rom 插值（带限近似，性价比高、无查表）。
 *
 * 状态可序列化，供分块/Worklet 续算。
 */
export class VariableRateResampler {
  private xm1 = 0;
  private x0 = 0;
  private readPos = 0;
  private consumed = 0;
  private outTime = 0;
  private ratioAt: (t: number) => number = () => 1;

  constructor(private sampleRate: number, curve?: DriftPoint[]) {
    if (curve) this.setCurve(curve);
  }

  setCurve(curve: DriftPoint[]): void {
    this.ratioAt = (t: number) => sampleRatioAt(curve, t);
  }

  /**
   * 灌入一块输入，产出尽量多的校正样本。
   * 输入末尾保留 2 个样本的插值余量，调用方需把未消费输入与下一块拼接。
   */
  process(input: Float32Array | Float64Array): Float32Array {
    const out: number[] = [];
    const dt = 1 / this.sampleRate;
    while (true) {
      const need = Math.ceil(this.readPos) + 2;
      if (need >= this.consumed + input.length) break;
      const q = this.readPos - this.consumed;
      const i = Math.floor(q);
      const frac = q - i;
      const p0 = i - 1 < 0 ? (i - 1 <= -2 ? this.xm1 : this.x0) : input[i - 1];
      const p1 = i < 0 ? this.x0 : input[i];
      const p2 = input[i + 1];
      const p3 = input[i + 2];
      out.push(catmullRom(p0, p1, p2, p3, frac));
      this.outTime += dt;
      this.readPos += this.ratioAt(this.outTime);
    }
    const len = input.length;
    if (len >= 2) {
      this.xm1 = input[len - 2];
      this.x0 = input[len - 1];
    } else if (len === 1) {
      this.xm1 = this.x0;
      this.x0 = input[0];
    }
    this.consumed += len;
    return Float32Array.from(out);
  }

  getState() {
    return {
      xm1: this.xm1, x0: this.x0,
      readPos: this.readPos, consumed: this.consumed, outTime: this.outTime,
    };
  }

  setState(s: ReturnType<VariableRateResampler['getState']>): void {
    Object.assign(this, s);
  }
}

/** Catmull-Rom 三次插值（a,b,c,d 为 x[-1..2]，t∈[0,1)） */
export function catmullRom(a: number, b: number, c: number, d: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * b +
    (-a + c) * t +
    (2 * a - 5 * b + 4 * c - d) * t2 +
    (-a + 3 * b - 3 * c + d) * t3
  );
}

/** FractionalDelay 历史缓冲的左/右环绕样本（边界钳制） */
function a_or(w: number[], base: number): number {
  return w[Math.max(0, 1 - base)];
}
function e_or(w: number[], base: number): number {
  return w[Math.min(3, 4 - base)];
}

/**
 * 分数延迟（三阶 Lagrange/Catmull-Rom，循环缓冲），用于声道方位对齐。
 * 正延迟 d∈[0,3) = 信号推迟 d 个样本。逐声道独立实例、状态可续算。
 */
export class FractionalDelay {
  /** 最近 4 个输入，w[3] 为最新 */
  private w = [0, 0, 0, 0];

  constructor(private delay: number) {
    if (delay < 0 || delay >= 3) throw new Error('本实现支持 [0,3) 样本分数延迟');
  }

  setDelay(d: number): void {
    if (d < 0 || d >= 3) throw new Error('延迟超出 [0,3) 范围');
    this.delay = d;
  }

  getDelay(): number {
    return this.delay;
  }

  process(x: number): number {
    const d = this.delay;
    const base = Math.floor(d); // 0,1,2
    const frac = d - base;
    // w[3]=最新样本 x_n，w[2]=x_{n-1}，w[1]=x_{n-2}，w[0]=x_{n-3}。
    // 延迟 base+frac 样本：在 x_{n-base}（w[3-base]）与更早一个样本
    // x_{n-base-1}（w[2-base]）之间按 frac 插值，frac 越大取越早的样本。
    const c = this.w[3 - base];                       // x_{n-base}
    const b = this.w[2 - base];                       // x_{n-base-1}
    // 零延迟（base=0,frac=0）时 Catmull-Rom 退化为恒等，直接取最新样本，
    // 跳过插值乘法但保持与通用路径完全相同的历史更新顺序。
    const y = d === 0 ? c : catmullRom(
      a_or(this.w, base), b, c, e_or(this.w, base), 1 - frac,
    );
    this.w.shift();
    this.w.push(x);
    return y;
  }

  processBlock(input: Float32Array): Float32Array {
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = this.process(input[i]);
    return out;
  }

  getState() {
    return { delay: this.delay, w: [...this.w] };
  }

  setState(s: ReturnType<FractionalDelay['getState']>): void {
    this.delay = s.delay;
    this.w = [...s.w];
  }
}
