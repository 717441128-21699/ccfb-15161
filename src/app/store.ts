import type { AppState, StateListener } from './state';

const initialState: AppState = {
  page: 'register',
  records: [],
  active: null,
  compareOriginal: true,
  storageUsage: 0,
  storageQuota: 0,
};

/**
 * 极简发布-订阅 store：单一不可变状态快照 + 受控更新。
 * 不引入框架，状态更新后浅拷贝触发监听者重渲染。
 */
class Store {
  private state: AppState = initialState;
  private listeners = new Set<StateListener>();

  getState(): AppState {
    return this.state;
  }

  /** 以补丁方式更新状态（浅合并顶层字段），然后通知所有监听者 */
  setState(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(l => l(this.state));
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }
}

export const store = new Store();
