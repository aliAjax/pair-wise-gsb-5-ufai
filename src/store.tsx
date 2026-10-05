import { createContext, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { AppState, AuditEntry, Batch, Release, SourceRecord } from './types';
import { fingerprintSource } from './lib/fingerprint';
import {
  advanceJob, clone, confirmBatch, ConfirmMaterial, createBatch, createRelease, createWriteJob,
  buildMaterialFromBatch, freezeBatch, migrateFingerprints, recomputeRelease, setObligationEvidence,
  setScope, startMigration, toggleScope, uid,
} from './lib/engine';

const STORAGE_KEY = 'license-lens-v2';
const now0 = Date.now();

function emptyState(): AppState {
  return {
    bootstrapped: false,
    sources: [],
    releases: [],
    batches: [],
    jobs: [],
    audit: [],
    migration: { running: false, done: 0, total: 0 },
    seq: 1,
  };
}

// 演示种子：依赖 + 第三方片段（其中 2 条为无指纹旧数据）
async function seed(): Promise<AppState> {
  const mk = async (partial: Omit<SourceRecord, 'id' | 'fingerprint' | 'addedAt'> & { fingerprint?: string | null }, i: number): Promise<SourceRecord> => {
    const fingerprint = partial.fingerprint === undefined
      ? await fingerprintSource({ kind: partial.kind, name: partial.name, version: partial.version, code: partial.code })
      : partial.fingerprint;
    const { fingerprint: _fp, ...rest } = partial;
    return { id: uid('src'), addedAt: now0 - 1000 * 60 * (60 - i), fingerprint, ...rest };
  };

  const throttleCode = `function throttle(fn, wait) {
  let last = 0;
  return function () {
    const now = Date.now();
    if (now - last >= wait) { last = now; return fn.apply(this, arguments); }
  };
}`;

  const sources: SourceRecord[] = [
    await mk({ kind: 'dependency', name: 'react', version: '18.3.1', license: 'MIT', copyrightHolder: 'Meta Platforms', originUrl: 'https://www.npmjs.com/package/react', modified: false }, 1),
    await mk({ kind: 'dependency', name: 'lodash', version: '4.17.21', license: 'MIT', copyrightHolder: 'OpenJS Foundation', originUrl: 'https://www.npmjs.com/package/lodash', modified: false }, 2),
    await mk({ kind: 'dependency', name: 'highlight.js', version: '11.10.0', license: 'BSD-3-Clause', copyrightHolder: 'Ivan Sagalaev', originUrl: 'https://www.npmjs.com/package/highlight.js', modified: false }, 3),
    await mk({ kind: 'dependency', name: 'chart.js', version: '4.4.4', license: 'MIT', copyrightHolder: 'Chart.js Contributors', originUrl: 'https://www.npmjs.com/package/chart.js', modified: false }, 4),
    await mk({ kind: 'dependency', name: 'legacy-parser', version: '2.1.0', license: 'GPL-3.0', copyrightHolder: 'Old Toolworks', originUrl: 'https://example.org/legacy-parser', modified: true, modificationNote: '调整了导出解析器的错误处理分支' }, 5),
    await mk({ kind: 'snippet', name: 'throttle 工具片段', license: 'MIT', copyrightHolder: 'Underscore.js', originUrl: 'https://underscorejs.org/docs/underscore.html', code: throttleCode, modified: false }, 6),
    // 同一片段被再次粘贴 → 与上一条指纹相同，归并后只产生一份义务
    await mk({ kind: 'snippet', name: '粘贴自 utils.js 的 throttle', license: 'MIT', copyrightHolder: 'Underscore.js', originUrl: 'https://underscorejs.org/', code: throttleCode, modified: false }, 7),
    // —— 无来源指纹的旧数据，必须先迁移 ——
    await mk({ kind: 'dependency', name: 'moment', version: '2.29.4', license: 'MIT', copyrightHolder: 'JS Foundation', originUrl: 'https://www.npmjs.com/package/moment', modified: false, legacy: true, fingerprint: null }, 8),
    await mk({ kind: 'snippet', name: '老项目遗留格式化片段', license: 'BSD-3-Clause', copyrightHolder: 'Dojo Foundation', code: 'function pad(n){return n<10?"0"+n:""+n}', modified: true, modificationNote: '补了一位数补零', legacy: true, fingerprint: null }, 9),
  ];

  let state: AppState = {
    ...emptyState(), sources, bootstrapped: true,
    migration: { running: false, done: sources.filter((s) => s.fingerprint).length, total: sources.length },
  };

  // 历史发布物 + 已冻结/已确认批次（v2.2）：冻结后其依据永不改变
  const old = createRelease(state, 'Aurora Web v2.2（历史发布物）', now0 - 86400000);
  state.releases.push(old);
  const fps = (names: string[]) =>
    sources.filter((s) => names.includes(s.name)).map((s) => s.fingerprint!) as string[];
  state = setScope(state, old.id, fps(['react', 'lodash', 'throttle 工具片段']), old.createdAt + 1000);
  for (const o of [...state.releases[0].obligations]) {
    state = setObligationEvidence(state, old.id, o.key, 'NOTICE 文件第 3 节已保留版权声明（v2.2 封存）', old.createdAt + 2000);
  }
  const b1 = createBatch(state, 'Aurora Web v2.2 发布批次', [old.id], old.createdAt + 3000);
  state = b1 as AppState;
  const batch = state.batches[0];
  state = freezeBatch(state, batch.id, batch.createdAt + 1000);
  const winnerMat: ConfirmMaterial = {
    owner: 'Zen Li（发布负责人 A）', note: 'v2.2 材料核对无误',
    releaseIds: [old.id], releases: clone(state.batches[0].frozen!.releases),
  };
  state = confirmBatch(state, batch.id, winnerMat, batch.createdAt + 2000);
  const j1 = createWriteJob(state, batch.id, batch.createdAt + 3000);
  state = j1 as AppState;
  const job = state.jobs[0];
  let t = batch.createdAt + 4000;
  while (state.jobs[0].state !== 'complete') { t += 500; state = advanceJob(state, job.id, t); }

  // 当前在制发布物（v2.3）：大部分义务已处理，留 1 项待补
  const cur = createRelease(state, 'Aurora Web v2.3（在制发布物）', now0 - 3600000);
  state.releases.push(cur);
  state = setScope(state, cur.id, fps(['react', 'lodash', 'highlight.js', 'chart.js', 'legacy-parser', 'throttle 工具片段']), cur.createdAt + 1000);
  const obls = state.releases.find((r) => r.id === cur.id)!.obligations;
  for (const o of obls) {
    if (o.sourceName === 'legacy-parser' && o.kind === 'modDisclosure') continue; // 留给用户处理
    const ev = o.kind === 'attribution' ? 'NOTICE 文件已保留版权声明与许可全文'
      : o.kind === 'sourceOffer' ? '源码包 src-orig-2.1.0.tar.gz 随发布物提供' : '已在 CHANGELOG 披露';
    state = setObligationEvidence(state, cur.id, o.key, ev, cur.createdAt + 2000);
  }
  state = recomputeRelease(state, cur.id, now0);
  return state;
}

interface StoreApi {
  state: AppState;
  act: (fn: (s: AppState) => AppState) => void;
  addSource: (input: {
    kind: 'dependency' | 'snippet'; name: string; version?: string; license: string;
    originUrl?: string; copyrightHolder?: string; code?: string; modified: boolean; modificationNote?: string;
  }) => Promise<void>;
  runMigration: () => Promise<void>;
  reset: () => void;
}

const Ctx = createContext<StoreApi | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(emptyState);
  const boot = useRef(false);

  useEffect(() => {
    if (boot.current) return;
    boot.current = true;
    (async () => {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          setState(JSON.parse(saved));
          return;
        }
      } catch { /* ignore */ }
      setState(await seed());
    })();
  }, []);

  useEffect(() => {
    if (state.bootstrapped) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const api = useMemo<StoreApi>(() => ({
    state,
    act: (fn) => setState((s) => fn(s)),
    addSource: async (input) => {
      const fingerprint = await fingerprintSource(input);
      setState((s) => ({
        ...s,
        sources: [...s.sources, { id: uid('src'), addedAt: Date.now(), fingerprint, ...input }],
      }));
    },
    runMigration: async () => {
      setState((s) => startMigration(s));
      const pending = state.sources.filter((x) => !x.fingerprint);
      for (let i = 0; i < pending.length; i++) {
        const rec = pending[i];
        const fingerprint = await fingerprintSource(rec);
        await new Promise((r) => setTimeout(r, 350)); // 可见的分批进度
        setState((s) => migrateFingerprints(s, [{ id: rec.id, fingerprint }], Date.now()));
      }
    },
    reset: () => {
      localStorage.removeItem(STORAGE_KEY);
      seed().then(setState);
    },
  }), [state]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useStore(): StoreApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('StoreProvider missing');
  return v;
}

// 便捷选择器
export const select = {
  pendingMigration: (s: AppState) => s.sources.filter((x) => !x.fingerprint),
  releaseById: (s: AppState, id: string): Release | undefined => s.releases.find((r) => r.id === id),
  batchById: (s: AppState, id: string): Batch | undefined => s.batches.find((b) => b.id === id),
  auditFor: (s: AppState, key: string): AuditEntry | undefined => s.audit.find((a) => a.idempotencyKey === key),
  grouped: (s: AppState) => {
    const map = new Map<string, SourceRecord[]>();
    for (const src of s.sources) {
      if (!src.fingerprint) continue;
      map.set(src.fingerprint, [...(map.get(src.fingerprint) ?? []), src]);
    }
    return map;
  },
};

export {
  advanceJob, buildMaterialFromBatch, confirmBatch, createBatch, createRelease, createWriteJob,
  freezeBatch, recomputeRelease, setObligationEvidence, setScope, toggleScope,
};
