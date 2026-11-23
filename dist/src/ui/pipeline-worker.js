// 处理管线 Web Worker:离线修复在后台线程跑,不卡界面。
import { restore } from '../dsp/pipeline.js';
self.onmessage = (ev) => {
    const { L, R, fs, azimuthParams } = ev.data;
    try {
        const result = restore(L, R, fs, {
            azimuthParams,
            onProgress: (frac, stage) => {
                self.postMessage({ type: 'progress', frac, stage });
            },
        });
        self.postMessage({ type: 'done', result }, [
            result.L.buffer, result.R.buffer,
            result.deviation.eps.buffer, result.eq.taps.buffer,
        ]);
    }
    catch (err) {
        self.postMessage({ type: 'error', message: String(err) });
    }
};
