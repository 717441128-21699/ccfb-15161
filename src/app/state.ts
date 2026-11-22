import type {
  AzimuthResult,
  WowFlutterReport,
  EqDesign,
  TapeSpec,
} from '../dsp/types';
import type { TapeRecord, RestorationReportRecord } from '../storage/idb';

/** 应用页面路由 */
export type PageId = 'register' | 'process' | 'listen' | 'archive';

/** 重新导出存储层类型，供页面统一从 state 引用 */
export type { TapeRecord, RestorationReportRecord };

/** 处理页内存中的活动会话（不持久化，音频数据可能很大） */
export interface ActiveSession {
  record: TapeRecord;
  channels: [Float32Array, Float32Array];
  sampleRate: number;
  spec: TapeSpec;
  drift?: WowFlutterReport;
  azimuth?: AzimuthResult;
  eq?: EqDesign[];
  restored?: [Float32Array, Float32Array];
  processing?: boolean;
  progress?: { phase: string; fraction: number; message: string };
}

/** 全局应用状态 */
export interface AppState {
  page: PageId;
  records: TapeRecord[];
  active: ActiveSession | null;
  /** 试听页 A/B 切换：true=原始，false=修复后 */
  compareOriginal: boolean;
  storageUsage: number;
  storageQuota: number;
}

export type StateListener = (state: AppState) => void;
