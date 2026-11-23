/**
 * IndexedDB 持久层：磁带登记信息、处理任务、归档结果与音频 Blob。
 * 无第三方依赖，手写一个极小的 Promise 包装。
 */

export interface TapeRecord {
  id: string;
  title: string;
  catalogNo: string;
  source: string; // 采访对象/栏目
  recordedYear: number;
  durationSeconds: number;
  sampleRate: number;
  notes: string;
  createdAt: number;
  tags: string[];
}

export interface JobRecord {
  id: string;
  tapeId: string;
  status: 'queued' | 'processing' | 'done' | 'failed';
  progress: number; // 0..1
  stage: string;
  startedAt: number;
  finishedAt?: number;
  params: RestorationParams;
  metrics?: RestorationMetrics;
  error?: string;
}

export interface RestorationParams {
  referenceHz: number;
  useHum: boolean;
  humHz: number;
  taps: number;
  maxBoostDb: number;
}

export interface RestorationMetrics {
  warpPeakPercent: number;
  azimuthArcmin: number;
  azimuthStdArcmin: number;
  delayMs: number;
  lossDbAt10k: number;
  residualDbAt10k: number;
  processingSeconds: number;
  realtimeFactor: number;
}

export interface ArchiveRecord {
  id: string;
  tapeId: string;
  jobId: string;
  archivedAt: number;
  originalWavId: string;
  restoredWavId: string;
  metrics: RestorationMetrics;
  notes: string;
}

interface BlobRecord {
  id: string;
  blob: Blob;
}

const DB_NAME = 'tape-restoration';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tapes')) db.createObjectStore('tapes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('archives')) db.createObjectStore('archives', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => {
          t.oncomplete = () => {
            db.close();
            resolve(req.result as T);
          };
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      }),
  );
}

export const db = {
  async put<T>(store: string, value: T): Promise<void> {
    await tx(store, 'readwrite', (s) => s.put(value as unknown as object));
  },
  async get<T>(store: string, key: string): Promise<T | undefined> {
    return tx<T | undefined>(store, 'readonly', (s) => s.get(key));
  },
  async getAll<T>(store: string): Promise<T[]> {
    return tx<T[]>(store, 'readonly', (s) => s.getAll());
  },
  async delete(store: string, key: string): Promise<void> {
    await tx(store, 'readwrite', (s) => s.delete(key));
  },
  async putBlob(id: string, blob: Blob): Promise<void> {
    const rec: BlobRecord = { id, blob };
    await tx('blobs', 'readwrite', (s) => s.put(rec));
  },
  async getBlob(id: string): Promise<Blob | undefined> {
    const rec = await tx<BlobRecord | undefined>('blobs', 'readonly', (s) => s.get(id));
    return rec?.blob;
  },
  async deleteBlob(id: string): Promise<void> {
    await tx('blobs', 'readwrite', (s) => s.delete(id));
  },
};

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
