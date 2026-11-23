// 处理管线 Web Worker:离线修复在后台线程跑,不卡界面。

import { restore } from '../dsp/pipeline.js';

interface RunMessage {
  L: Float32Array;
  R: Float32Array;
  fs: number;
  azimuthParams?: { tapeSpeedMms: number; trackSpacingMm: number; trackWidthMm: number };
}

self.onmessage = (ev: MessageEvent<RunMessage>) => {
  const { L, R, fs, azimuthParams } = ev.data;
  try {
    const result = restore(L, R, fs, {
      azimuthParams,
      onProgress: (frac, stage) => {
        (self as unknown as Worker).postMessage({ type: 'progress', frac, stage });
      },
    });
    (self as unknown as Worker).postMessage(
      { type: 'done', result },
      [
        result.L.buffer, result.R.buffer,
        result.deviation.eps.buffer, result.eq.taps.buffer,
      ] as unknown as Transferable[]
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', message: String(err) });
  }
};
