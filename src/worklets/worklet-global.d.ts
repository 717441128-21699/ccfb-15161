/**
 * AudioWorklet 全局环境声明。
 *
 * 当前 TypeScript 版本的 lib.dom.d.ts 未完整暴露 AudioWorklet 全局作用域
 * （AudioWorkletProcessor 基类与 registerProcessor 全局函数），而 worklet
 * 文件运行在独立的 AudioWorkletGlobalScope，不经过主页面的 DOM 类型。
 * 这里补齐最小可用声明，使 worklet 处理器通过严格类型检查。
 */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}

interface AudioWorkletNodeOptions {
  numberOfInputs?: number;
  numberOfOutputs?: number;
  inputChannelCount?: number[];
  outputChannelCount?: number[];
  processorOptions?: Record<string, unknown>;
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;
