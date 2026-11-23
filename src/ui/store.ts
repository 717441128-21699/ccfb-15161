// 会话状态 + 本地持久化(登记表 / 归档记录)

export interface TapeRecord {
  id: string;
  title: string;      // 磁带编号
  era: string;        // 年代
  tapeType: string;   // 盒带 / 开盘
  speed: string;      // 带速
  brand: string;
  content: string;    // 内容描述
  operator: string;   // 数字化人
  note: string;
  createdAt: string;
}

export interface ArchiveRecord {
  id: string;
  tapeId: string;
  fileName: string;
  archivedAt: string;
  durationSec: number;
  sampleRate: number;
  refType: string;
  refFreq: number;
  azimuthArcmin: number;
  azimuthDtUs: number;
  eqLossDbAt10k: number;
  eqResidualDbAt10k: number;
  residualWowFlutter: number;
  processMs: number;
}

export interface SessionState {
  tapeId: string | null;
  fileName: string | null;
  sampleRate: number;
  origL: Float32Array | null;
  origR: Float32Array | null;
  result: import('../dsp/pipeline.js').RestoreResult | null;
}

export const session: SessionState = {
  tapeId: null,
  fileName: null,
  sampleRate: 44100,
  origL: null,
  origR: null,
  result: null,
};

const REG_KEY = 'tapeRescue.registry';
const ARC_KEY = 'tapeRescue.archive';

function load<T>(key: string): T[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '[]') as T[];
  } catch {
    return [];
  }
}

function save(key: string, rows: unknown[]): void {
  localStorage.setItem(key, JSON.stringify(rows));
}

export const registry = {
  list(): TapeRecord[] { return load<TapeRecord>(REG_KEY); },
  add(rec: TapeRecord): void { const r = registry.list(); r.push(rec); save(REG_KEY, r); },
  get(id: string): TapeRecord | undefined { return registry.list().find((t) => t.id === id); },
  remove(id: string): void { save(REG_KEY, registry.list().filter((t) => t.id !== id)); },
};

export const archive = {
  list(): ArchiveRecord[] { return load<ArchiveRecord>(ARC_KEY); },
  add(rec: ArchiveRecord): void { const r = archive.list(); r.push(rec); save(ARC_KEY, r); },
  remove(id: string): void { save(ARC_KEY, archive.list().filter((t) => t.id !== id)); },
};

export function uid(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}
