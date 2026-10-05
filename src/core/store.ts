import { useEffect, useRef, useState } from 'react';
import type { AppState } from './types.js';
import { buildSeed } from './seed.js';

const KEY = 'license-lens-release-state-v1';

function load(): AppState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as AppState;
  } catch {
    /* 损坏数据回退到种子 */
  }
  return buildSeed();
}

/** 全局不可变状态容器：所有变更在 reducer 中完成后整体替换并持久化 */
export interface Store {
  state: AppState;
  /** 对状态执行一次原地可变变更（引擎按 reducer 风格设计），然后提交快照 */
  commit: (fn: (draft: AppState) => void) => void;
  reset: () => void;
}

export function useStore(): Store {
  const [state, setState] = useState<AppState>(load);
  const ref = useRef(state);
  ref.current = state;

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(ref.current));
  }, [state]);

  return {
    state,
    commit: fn => {
      const draft: AppState = structuredClone(ref.current);
      fn(draft);
      ref.current = draft;
      setState(draft);
    },
    reset: () => {
      const seed = buildSeed();
      ref.current = seed;
      setState(seed);
    },
  };
}
