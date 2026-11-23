/**
 * 应用会话状态：当前磁带、导入音频、修复结果，跨页面共享。
 * 持久记录走 IndexedDB（db.ts），大块音频在内存中按当前作业保留。
 */
import type { TapeRecord, JobRecord, RestorationParams, RestorationMetrics } from '../db';
import { encodeStereoWav } from '../dsp/wav';

export interface AudioBundle {
  sampleRate: number;
  channels: Float64Array[]; // [left, right]
}

export interface SessionState {
  tape?: TapeRecord;
  original?: AudioBundle;
  restored?: AudioBundle;
  job?: JobRecord;
  metrics?: RestorationMetrics;
  params?: RestorationParams;
  /** 试听页当前选择：原始 / 修复。 */
  listenMode: 'original' | 'restored';
}

export const state: SessionState = {
  listenMode: 'restored',
};

export const DEFAULT_PARAMS: RestorationParams = {
  referenceHz: 1000,
  useHum: false,
  humHz: 50,
  taps: 161,
  maxBoostDb: 12,
};

export function bundleToWavBlob(bundle: AudioBundle): Blob {
  return encodeStereoWav(bundle.channels[0], bundle.channels[1], bundle.sampleRate);
}
