/** IndexedDB 归档存储：磁带登记信息、原始/修复 Blob、报告 */

export type TapeStatus = 'registered' | 'processing' | 'processed' | 'archived';

export interface RestorationReportRecord {
  /** 实际锁定的跟踪频率（Hz） */
  trackHz: number;
  /** 跟踪源描述（参考音/交流哼声） */
  trackSource: string;
  azimuthArcmin: number;
  azimuthErrorArcmin?: number;
  /** 每通道 10kHz 补偿残差（dB） */
  eqResidual10kDb: number[];
  residualAt10kDb?: number;
  wowFlutterPct: number;
  wowRmsPct: number;
  flutterRmsPct: number;
  realtimeFactor: number;
  elapsedMs: number;
  scenario?: string;
  processedAt?: number;
}

export interface TapeRecord {
  id: string;
  title: string;
  catalogNo: string;
  source: string;
  recordedYear?: number;
  /** 登记后、导入音频前可能为空 */
  durationSec?: number;
  sampleRate?: number;
  createdAt: number;
  notes?: string;
  status: TapeStatus;
  originalBlobId?: string;
  restoredBlobId?: string;
  report?: RestorationReportRecord;
}

const DB_NAME = 'tape-restoration-studio';
const DB_VERSION = 1;
const TAPES = 'tapes';
const BLOBS = 'blobs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TAPES)) db.createObjectStore(TAPES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

export async function putTape(record: TapeRecord): Promise<void> {
  const db = await openDb();
  await tx(db, TAPES, 'readwrite', s => s.put(record));
  db.close();
}

export async function getTape(id: string): Promise<TapeRecord | undefined> {
  const db = await openDb();
  const r = await tx<TapeRecord | undefined>(db, TAPES, 'readonly', s => s.get(id));
  db.close();
  return r;
}

export async function listTapes(): Promise<TapeRecord[]> {
  const db = await openDb();
  const all = await tx<TapeRecord[]>(db, TAPES, 'readonly', s => s.getAll());
  db.close();
  return (all ?? []).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteTape(id: string): Promise<void> {
  const db = await openDb();
  const tape = await tx<TapeRecord | undefined>(db, TAPES, 'readonly', s => s.get(id));
  if (tape) {
    await Promise.all([
      tape.originalBlobId ? tx(db, BLOBS, 'readwrite', s => s.delete(tape.originalBlobId!)) : Promise.resolve(),
      tape.restoredBlobId ? tx(db, BLOBS, 'readwrite', s => s.delete(tape.restoredBlobId!)) : Promise.resolve(),
    ]);
  }
  await tx(db, TAPES, 'readwrite', s => s.delete(id));
  db.close();
}

export async function putBlob(id: string, blob: Blob): Promise<void> {
  const db = await openDb();
  await tx(db, BLOBS, 'readwrite', s => s.put(blob, id));
  db.close();
}

export async function getBlob(id: string): Promise<Blob | undefined> {
  const db = await openDb();
  const r = await tx<Blob | undefined>(db, BLOBS, 'readonly', s => s.get(id));
  db.close();
  return r;
}

export async function deleteBlob(id: string): Promise<void> {
  const db = await openDb();
  await tx(db, BLOBS, 'readwrite', s => s.delete(id));
  db.close();
}

export async function estimateStorage(): Promise<{ usage: number; quota: number }> {
  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  }
  return { usage: 0, quota: 0 };
}
