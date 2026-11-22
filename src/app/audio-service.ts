import { putTape, getTape, listTapes, deleteTape, deleteBlob, putBlob, getBlob, estimateStorage } from '../storage/idb';
import { encodeWav16, decodeWavStream, type PcmChunk } from '../audio/wav-codec';
import type { TapeRecord } from './state';
import type { TapeSpec } from '../dsp/types';

/** 默认开盘带物理规格（1/4 英寸、19.05cm/s） */
export const DEFAULT_SPEC: TapeSpec = {
  trackSpacingM: 1.78e-3,
  tapeSpeed: 0.1905,
  sampleRate: 48000,
  refToneHz: 1000,
  refChannel: 0,
  humHz: 50,
};

function genId(): string {
  return `tape_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 登记一条新磁带（不含音频） */
export async function registerTape(input: {
  title: string;
  catalogNo: string;
  source: string;
  recordedYear?: number;
  notes?: string;
}): Promise<TapeRecord> {
  const record: TapeRecord = {
    id: genId(),
    title: input.title,
    catalogNo: input.catalogNo,
    source: input.source,
    recordedYear: input.recordedYear,
    notes: input.notes,
    createdAt: Date.now(),
    status: 'registered',
  };
  await putTape(record);
  return record;
}

/** 读取全部磁带记录，按创建时间倒序 */
export async function loadTapes(): Promise<TapeRecord[]> {
  const tapes = await listTapes();
  return tapes.sort((a, b) => b.createdAt - a.createdAt);
}

export async function removeTape(id: string): Promise<void> {
  const tape = await getTape(id);
  if (tape?.originalBlobId) await deleteBlob(tape.originalBlobId);
  if (tape?.restoredBlobId) await deleteBlob(tape.restoredBlobId);
  await deleteTape(id);
}

/**
 * 导入 WAV 文件：解码为平面立体声 Float32 通道，同时把原始 Blob 存档。
 * 采用分块解码，避免整文件载入占用过多内存。
 */
export async function importWav(
  file: File,
  record: TapeRecord,
): Promise<{ channels: [Float32Array, Float32Array]; sampleRate: number; durationSec: number }> {
  const blobId = `blob_${record.id}_orig`;
  await putBlob(blobId, file);

  const chunks: PcmChunk[] = [];
  const meta = await decodeWavStream(file, chunk => { chunks.push(chunk); });
  if (meta.channels !== 2) throw new Error('当前仅支持立体声 WAV（双声道）');

  // 拼接分块为连续平面声道
  const totalFrames = chunks.reduce((s, c) => s + c.channels[0].length, 0);
  const L = new Float32Array(totalFrames);
  const R = new Float32Array(totalFrames);
  let off = 0;
  for (const c of chunks) {
    L.set(c.channels[0], off);
    R.set(c.channels[1], off);
    off += c.channels[0].length;
  }

  const updated: TapeRecord = {
    ...record,
    status: 'registered',
    originalBlobId: blobId,
    sampleRate: meta.sampleRate,
    durationSec: totalFrames / meta.sampleRate,
  };
  await putTape(updated);

  return { channels: [L, R], sampleRate: meta.sampleRate, durationSec: totalFrames / meta.sampleRate };
}

/** 把修复后的平面立体声编码为 16-bit WAV 并持久化 */
export async function saveRestoredWav(
  record: TapeRecord,
  channels: [Float32Array, Float32Array],
  sampleRate: number,
): Promise<{ blobId: string; blob: Blob }> {
  const n = Math.min(channels[0].length, channels[1].length);
  const interleaved = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    interleaved[2 * i] = channels[0][i];
    interleaved[2 * i + 1] = channels[1][i];
  }
  const blob = encodeWav16(interleaved, sampleRate, 2);
  const blobId = `blob_${record.id}_restored`;
  await putBlob(blobId, blob);
  return { blobId, blob };
}

export async function refreshStorageUsage(): Promise<{ usage: number; quota: number }> {
  return estimateStorage();
}

export { getBlob };
