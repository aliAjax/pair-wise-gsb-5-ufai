import type {
  AppState, Artifact, Batch, Confirmation, FrozenBasis, MaterialDiffEntry,
  Obligation, ObligationType, RunResult, ScopeSig, SourceRecord, SourceRef,
} from './types.js';
import {
  OBLIGATION_LABEL, computeFingerprint, obligationBasis, obligationMaterial,
  requiredObligations,
} from './fingerprint.js';

// ---------- 基础工具 ----------

export function createState(): AppState {
  return { sources: [], artifacts: {}, batches: [], audit: [], idemSeen: [], alias: {}, seq: 0 };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function nextId(state: AppState, prefix: string): string {
  state.seq += 1;
  return `${prefix}${state.seq}`;
}

function consumeIdem(state: AppState, key: string): boolean {
  if (state.idemSeen.includes(key)) return false;
  state.idemSeen.push(key);
  return true;
}

function audit(state: AppState, type: string, detail: string, batchId?: string, idemKey?: string) {
  state.seq += 1;
  state.audit.push({ seq: state.seq, at: Date.now(), type, detail, batchId, idemKey });
}

export function resolveSourceId(state: AppState, id: string): string {
  return state.alias[id] ?? id;
}

export function findSource(state: AppState, id: string): SourceRecord | undefined {
  return state.sources.find(s => s.id === resolveSourceId(state, id));
}

export function obKey(batchId: string, sourceId: string, type: ObligationType): string {
  return `${batchId}:${sourceId}:${type}`;
}

// ---------- 范围签名 ----------

/** 计算批次当前范围内每个来源的签名；只依赖发布物组成与引用状态 */
function computeScope(state: AppState, batch: Batch): Record<string, ScopeSig> {
  const sig: Record<string, ScopeSig> = {};
  for (const aid of batch.artifactIds) {
    const art = state.artifacts[aid];
    if (!art) continue;
    for (const sid0 of art.sourceIds) {
      const sid = resolveSourceId(state, sid0);
      const src = state.sources.find(s => s.id === sid);
      if (!src) continue;
      const entry = sig[sid] ?? {
        artifacts: [], modified: false, present: false,
        license: src.license, version: src.version,
      };
      entry.artifacts.push(aid);
      for (const ref of src.refs) {
        if (!ref.removed) {
          entry.present = true;
          if (ref.modified) entry.modified = true;
        }
      }
      entry.license = src.license;
      entry.version = src.version;
      sig[sid] = entry;
    }
  }
  for (const e of Object.values(sig)) e.artifacts.sort();
  return sig;
}

function sigEqual(a: ScopeSig, b: ScopeSig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function makeObligation(batch: Batch, src: SourceRecord, type: ObligationType): Obligation {
  return {
    key: obKey(batch.id, src.id, type),
    batchId: batch.id,
    sourceId: src.id,
    fingerprint: src.fingerprint,
    type,
    status: 'pending',
    material: obligationMaterial(type, src.name, src.version),
    basis: obligationBasis(type, src.license),
    createdAt: Date.now(),
  };
}

/**
 * 把某批次的义务对齐到当前范围，只处理签名发生变化的来源（指纹归并粒度）。
 * 义务以稳定 key upsert：重试不会产生重复义务或重复审计。
 */
function reconcile(state: AppState, batch: Batch, nextSig: Record<string, ScopeSig>, force = false): string[] {
  const changed: string[] = [];
  if (batch.status !== 'open') return changed;

  for (const [sid, sig] of Object.entries(nextSig)) {
    const old = batch.scopeSig[sid];
    if (!force && old && sigEqual(old, sig)) continue;
    changed.push(sid);
    const src = state.sources.find(s => s.id === sid);
    if (!src) continue;

    let rows = batch.obligations.filter(o => o.sourceId === sid);

    if (!sig.present) {
      // 片段 / 依赖已撤出全部发布物：义务撤回，记录保留；冻结批次不受影响
      for (const o of rows) {
        if (o.status !== 'withdrawn') {
          o.status = 'withdrawn';
          audit(state, 'obligation.withdraw', `发布范围不再包含「${src.name}」，撤回${OBLIGATION_LABEL[o.type]}（${o.key}）`, batch.id);
        }
      }
    } else {
      const wanted = src.fingerprint ? requiredObligations(sig.license, sig.modified) : [];
      const byType = new Map(rows.map(o => [o.type, o]));
      for (const type of wanted) {
        let o = byType.get(type);
        if (!o) {
          o = makeObligation(batch, src, type);
          batch.obligations.push(o);
          audit(state, 'obligation.generate', `为「${src.name}」生成${OBLIGATION_LABEL[type]}义务（${o.key}）`, batch.id);
        } else if (o.status === 'withdrawn') {
          // 同一指纹重新进入发布范围：沿用稳定 key 重新挂起，不生成新义务
          const fresh = makeObligation(batch, src, type);
          o.status = 'pending';
          o.material = fresh.material;
          o.basis = fresh.basis;
          o.fingerprint = src.fingerprint;
          delete o.evidence;
          delete o.satisfiedAt;
          audit(state, 'obligation.reactivate', `「${src.name}」重新进入范围，恢复${OBLIGATION_LABEL[type]}义务（${o.key}）`, batch.id);
        } else if (o.basis !== obligationBasis(type, sig.license) || o.material !== obligationMaterial(type, src.name, src.version)) {
          // 许可证 / 版本变化导致依据变化：重新挂起要求复核，已交材料不再自动有效
          const wasSatisfied = o.status === 'satisfied';
          o.status = 'pending';
          o.basis = obligationBasis(type, sig.license);
          o.material = obligationMaterial(type, src.name, src.version);
          delete o.evidence;
          delete o.satisfiedAt;
          audit(state, 'obligation.rebasis', `「${src.name}」许可依据变更（${sig.license}），${OBLIGATION_LABEL[type]}需重新确认`, batch.id);
          void wasSatisfied;
        }
      }
      // 范围不再要求的挂起义务（如修改已回退导致的修改披露）撤回；已满足的保留历史
      for (const t of ['attribution', 'sourceOffer', 'modificationDisclosure'] as ObligationType[]) {
        if (wanted.includes(t)) continue;
        const o = byType.get(t);
        if (o && o.status === 'pending') {
          o.status = 'withdrawn';
          audit(state, 'obligation.withdraw', `「${src.name}」不再需要${OBLIGATION_LABEL[t]}（${o.key}）`, batch.id);
        }
      }
    }
  }

  // 整个来源已不在任何发布物中
  for (const sid of Object.keys(batch.scopeSig)) {
    if (nextSig[sid]) continue;
    changed.push(sid);
    for (const o of batch.obligations.filter(o => o.sourceId === sid && o.status !== 'withdrawn')) {
      const src = state.sources.find(s => s.id === sid);
      o.status = 'withdrawn';
      audit(state, 'obligation.withdraw', `来源移出全部发布物，撤回「${src?.name ?? sid}」的${OBLIGATION_LABEL[o.type]}`, batch.id);
    }
  }

  // 撤回行保留在批次内作为处理痕迹，但不进入报告与冻结快照
  batch.scopeSig = nextSig;
  return [...new Set(changed)];
}

/** 开放批次同步当前范围（添加 / 撤下来源、改许可证、改发布物后调用）；冻结批次原样保留 */
export function syncOpenBatches(state: AppState, opts: { artifactIds?: string[]; sourceIds?: string[] } = {}) {
  for (const batch of state.batches) {
    if (batch.status !== 'open') continue;
    if (opts.artifactIds && !batch.artifactIds.some(id => opts.artifactIds!.includes(id))) continue;
    // reconcile 内部逐指纹比较签名，未变化的来源不会重算
    reconcile(state, batch, computeScope(state, batch));
  }
  void opts.sourceIds;
}

// ---------- 旧数据迁移 ----------

export interface MigrationReport {
  migratedRefs: number;
  mergedGroups: Array<{ fingerprint: string; name: string; mergedIds: string[] }>;
  alreadyDone: boolean;
}

/**
 * 旧数据没有来源指纹：先补指纹，再按指纹归并引用、重定向发布物。
 * 迁移未完成时，runChecklist / 出报告被闸门拦截。
 */
export function migrateLegacy(state: AppState): MigrationReport {
  const legacy = state.sources.filter(s => !s.fingerprint);
  if (legacy.length === 0) return { migratedRefs: 0, mergedGroups: [], alreadyDone: true };

  audit(state, 'migration.start', `开始迁移 ${legacy.length} 条无指纹旧数据`);

  const groups = new Map<string, SourceRecord[]>();
  for (const src of legacy) {
    src.fingerprint = computeFingerprint(src);
    const list = groups.get(src.fingerprint) ?? [];
    list.push(src);
    groups.set(src.fingerprint, list);
  }

  let migratedRefs = 0;
  const mergedGroups: MigrationReport['mergedGroups'] = [];

  for (const [fp, list] of groups) {
    const canonical = list[0];
    const mergedIds = list.slice(1).map(s => s.id);
    if (mergedIds.length) mergedGroups.push({ fingerprint: fp, name: canonical.name, mergedIds });
    for (const dup of list.slice(1)) {
      for (const ref of dup.refs) {
        if (!canonical.refs.some(r => r.kind === ref.kind && r.location === ref.location)) {
          canonical.refs.push(ref);
        }
      }
      state.alias[dup.id] = canonical.id;
    }
    for (const art of Object.values(state.artifacts)) {
      const mapped = art.sourceIds.map(id => state.alias[id] ?? id);
      art.sourceIds = [...new Set(mapped)];
    }
    migratedRefs += list.reduce((n, s) => n + s.refs.length, 0);
  }

  state.sources = state.sources.filter(s => !(s.id in state.alias));

  // 迁移完成后，开放批次从头建立范围与义务
  for (const batch of state.batches) {
    if (batch.status !== 'open') continue;
    batch.processedArtifacts = [];
    batch.interruptedAt = undefined;
    batch.obligations = [];
    batch.scopeSig = {};
    const next = computeScope(state, batch);
    reconcile(state, batch, next, true);
  }

  audit(state, 'migration.done', `迁移完成：${legacy.length} 条旧记录归并为 ${groups.size} 个指纹来源，合并重复记录 ${mergedGroups.length} 组`);
  return { migratedRefs, mergedGroups, alreadyDone: false };
}

// ---------- 来源接入 / 撤下 / 补全 ----------

export interface IngestInput {
  kind: SourceRef['kind'];
  name: string;
  version?: string;
  upstream?: string;
  license: string;
  location: string;
  modified?: boolean;
  legacy?: boolean;
  artifactIds?: string[];
}

/** 接入一个依赖或代码片段；同指纹自动归并引用，并把来源挂到指定发布物 */
export function ingestSource(state: AppState, input: IngestInput): SourceRecord {
  const fingerprint = input.legacy ? '' : computeFingerprint(input);
  let src = input.legacy ? undefined : state.sources.find(s => s.fingerprint === fingerprint);

  if (!src) {
    src = {
      id: nextId(state, 's'),
      fingerprint,
      name: input.name,
      version: input.version,
      upstream: input.upstream,
      license: input.license,
      refs: [],
    };
    state.sources.push(src);
  } else {
    // 归并：许可证 / 版本若有更明确的信息则补齐
    if (input.version && !src.version) src.version = input.version;
    if (input.upstream && !src.upstream) src.upstream = input.upstream;
  }

  const existingRef = src.refs.find(r => r.kind === input.kind && r.location === input.location);
  if (existingRef) {
    // 同一指纹来源在同一位置被重复登记（含依赖与片段两种接入路径）：归并引用
    if (input.modified) existingRef.modified = true;
    if (existingRef.removed) delete existingRef.removed;
  } else {
    src.refs.push({
      id: nextId(state, 'ref'),
      kind: input.kind,
      location: input.location,
      modified: input.modified,
      legacy: input.legacy,
    });
  }

  const touchedArtifacts: string[] = [];
  for (const aid of input.artifactIds ?? []) {
    const art = state.artifacts[aid];
    if (!art) continue;
    if (!art.sourceIds.includes(src.id)) art.sourceIds.push(src.id);
    touchedArtifacts.push(aid);
  }

  audit(
    state,
    'source.ingest',
    `${input.kind === 'snippet' ? '代码片段' : '依赖'}「${input.name}」按指纹 ${src.fingerprint || '（待迁移）'} 归并到来源 ${src.id}` +
      (touchedArtifacts.length ? `，发布物 ${touchedArtifacts.join(', ')}` : ''),
  );
  syncOpenBatches(state, { artifactIds: touchedArtifacts.length ? touchedArtifacts : undefined, sourceIds: [src.id] });
  return src;
}

/** 撤下某个引用（片段删除 / 依赖移出）：引用留痕，义务按受影响范围重算 */
export function withdrawRef(state: AppState, sourceId: string, refId: string, reason: string) {
  const src = findSource(state, sourceId);
  const ref = src?.refs.find(r => r.id === refId);
  if (!src || !ref || ref.removed) return;
  ref.removed = true;
  audit(state, 'source.withdraw', `撤下「${src.name}」在 ${ref.location} 的${ref.kind === 'snippet' ? '片段' : '依赖'}引用：${reason}`);
  // 仅由 syncOpenBatches 对齐一次范围，避免同一指纹被重算两遍
  syncOpenBatches(state, { sourceIds: [src.id] });
}

/** 未知许可证补全；补全前该来源只挂闸门，不产生义务、不进报告 */
export function resolveLicense(state: AppState, sourceId: string, license: string) {
  const src = findSource(state, sourceId);
  if (!src) return;
  const before = src.license;
  if (before === license) return;
  src.license = license;
  audit(state, 'source.resolve-license', `「${src.name}」许可证补全：${before} → ${license}`);
  syncOpenBatches(state, { sourceIds: [src.id] });
}

// ---------- 发布物与批次 ----------

export function createBatch(state: AppState, name: string): Batch {
  const batch: Batch = {
    id: nextId(state, 'b'),
    name,
    version: 1,
    status: 'open',
    artifactIds: [],
    processedArtifacts: [],
    scopeSig: {},
    obligations: [],
    confirmations: [],
    reportKeys: [],
    createdAt: Date.now(),
  };
  state.batches.push(batch);
  audit(state, 'batch.create', `创建发布批次「${name}」（${batch.id}）`, batch.id);
  return batch;
}

export function createArtifact(state: AppState, batchId: string, name: string, sourceIds: string[] = []): Artifact | undefined {
  const batch = state.batches.find(b => b.id === batchId);
  if (!batch || batch.status !== 'open') return undefined;
  const art: Artifact = { id: nextId(state, 'a'), name, sourceIds: [...new Set(sourceIds.map(id => resolveSourceId(state, id)))] };
  state.artifacts[art.id] = art;
  batch.artifactIds.push(art.id);
  audit(state, 'artifact.create', `批次「${batch.name}」新增发布物「${name}」（${art.id}）`, batch.id);
  syncOpenBatches(state, { artifactIds: [art.id] });
  return art;
}

export function removeArtifact(state: AppState, batchId: string, artifactId: string) {
  const batch = state.batches.find(b => b.id === batchId);
  if (!batch || batch.status !== 'open') return;
  if (!batch.artifactIds.includes(artifactId)) return;
  batch.artifactIds = batch.artifactIds.filter(id => id !== artifactId);
  batch.processedArtifacts = batch.processedArtifacts.filter(id => id !== artifactId);
  delete state.artifacts[artifactId];
  audit(state, 'artifact.remove', `批次「${batch.name}」移除发布物（${artifactId}），相关署名只对受影响来源重算`, batch.id);
  syncOpenBatches(state);
}

export function attachSources(state: AppState, batchId: string, artifactId: string, sourceIds: string[]) {
  const batch = state.batches.find(b => b.id === batchId);
  const art = batch && state.artifacts[artifactId];
  if (!batch || !art || batch.status !== 'open') return;
  for (const id of sourceIds.map(id => resolveSourceId(state, id))) {
    if (!art.sourceIds.includes(id)) art.sourceIds.push(id);
  }
  audit(state, 'artifact.attach', `发布物「${art.name}」纳入 ${sourceIds.length} 个指纹来源`, batch.id);
  syncOpenBatches(state, { artifactIds: [artifactId] });
}

// ---------- 续作清单：按发布物推进，中断可续 ----------

export interface RunOptions {
  /** 本次请求幂等键；相同请求重试不产生重复义务或审计 */
  idemKey: string;
  /** 模拟写入中断：处理完 N 个新发布物后中断（测试 / 演示用） */
  failAfter?: number;
}

export function runChecklist(state: AppState, batchId: string, opts: RunOptions): RunResult {
  const batch = state.batches.find(b => b.id === batchId);
  if (!batch) return { processedThisRun: [], changedFingerprints: [] };

  if (state.sources.some(s => !s.fingerprint && batch.artifactIds.some(a => state.artifacts[a]?.sourceIds.includes(s.id)))) {
    return { blocked: 'legacy', processedThisRun: [], changedFingerprints: [] };
  }
  if (batch.status !== 'open') {
    return { blocked: 'frozen', processedThisRun: [], changedFingerprints: [] };
  }

  const resume = batch.interruptedAt !== undefined;
  if (!resume) {
    // 仅“完整成功之后的重试”才按幂等键跳过；中断后的重试必须续跑
    if (!consumeIdem(state, opts.idemKey)) {
      return { processedThisRun: [], changedFingerprints: [], interrupted: false };
    }
  } else if (state.idemSeen.includes(opts.idemKey)) {
    // 中断前已登记、但同键再次触发：同样只做续跑，不补登记、不重复义务
  }

  // 先做范围对齐，只重算受影响指纹
  const nextSig = computeScope(state, batch);
  const beforeChanged = new Set(reconcile(state, batch, nextSig));

  // 中断续跑时失败注入只属于“那次中断”，重试不再中断，确保从最后一个完整发布物继续
  const failAfter = resume ? undefined : opts.failAfter;

  const processedThisRun: string[] = [];
  for (const aid of batch.artifactIds) {
    if (batch.processedArtifacts.includes(aid)) continue; // 从最后一个完整发布物继续
    const art = state.artifacts[aid];
    if (!art) {
      batch.processedArtifacts.push(aid);
      continue;
    }
    for (const sid of art.sourceIds) {
      const real = resolveSourceId(state, sid);
      beforeChanged.add(real);
    }
    // 稳定 key upsert：义务若已存在则不会重复生成
    processedThisRun.push(aid);
    batch.processedArtifacts.push(aid);
    audit(state, 'run.artifact-done', `发布物「${art.name}」义务核对完成并落盘检查点`, batch.id);

    if (failAfter !== undefined && processedThisRun.length >= failAfter) {
      batch.interruptedAt = Date.now();
      audit(state, 'run.interrupted', `写入中断，检查点停在发布物「${art.name}」；续跑将从下一发布物开始`, batch.id);
      return {
        interrupted: true,
        processedThisRun,
        changedFingerprints: [...beforeChanged].map(id => state.sources.find(s => s.id === id)?.fingerprint ?? id),
      };
    }
  }

  batch.interruptedAt = undefined;
  if (processedThisRun.length) {
    audit(
      state,
      resume ? 'run.resumed' : 'run.done',
      `${resume ? '中断后续跑' : '清单推进'}完成，新处理 ${processedThisRun.length} 个发布物，全部 ${batch.processedArtifacts.length}/${batch.artifactIds.length} 个发布物已核对；重试未重复生成义务`,
      batch.id,
    );
  }
  // processedThisRun 为空表示重试落在最后一个完整发布物之后：不写审计、不重复生成
  return {
    processedThisRun,
    changedFingerprints: resume ? [...beforeChanged].map(id => state.sources.find(s => s.id === id)?.fingerprint ?? id) : [],
  };
}

export function provideEvidence(state: AppState, batchId: string, obligationKey: string, evidence: string, owner: string) {
  const batch = state.batches.find(b => b.id === batchId);
  const ob = batch?.obligations.find(o => o.key === obligationKey);
  if (!batch || !ob || ob.status === 'withdrawn' || batch.status !== 'open') return;
  ob.evidence = evidence;
  ob.owner = owner;
  ob.status = 'satisfied';
  ob.satisfiedAt = Date.now();
  audit(state, 'obligation.satisfy', `${owner} 交付「${ob.material}」的材料：${evidence}`, batch.id);
}

// ---------- 冻结：固定依据快照 ----------

export function freezeBatch(state: AppState, batchId: string, note = ''): { ok: boolean; reason?: string } {
  const batch = state.batches.find(b => b.id === batchId);
  if (!batch) return { ok: false, reason: '批次不存在' };
  if (batch.status === 'frozen' || batch.status === 'confirmed') return { ok: false, reason: '批次已冻结，依据不可更改' };
  if (batch.interruptedAt) return { ok: false, reason: '清单存在写入中断，请先续跑完成' };
  if (batch.processedArtifacts.length !== batch.artifactIds.length) return { ok: false, reason: '尚有发布物未完成义务核对' };

  const inScope = new Set<string>();
  for (const aid of batch.artifactIds) for (const id of state.artifacts[aid]?.sourceIds ?? []) inScope.add(resolveSourceId(state, id));

  const snapshot: FrozenBasis = {
    frozenAt: Date.now(),
    sources: state.sources
      .filter(s => inScope.has(s.id))
      .map(s => ({ id: s.id, fingerprint: s.fingerprint, name: s.name, version: s.version, license: s.license, refs: clone(s.refs) })),
    obligations: clone(batch.obligations.filter(o => o.status !== 'withdrawn')),
    artifacts: batch.artifactIds.map(a => clone(state.artifacts[a])).filter(Boolean),
    scopeSig: clone(batch.scopeSig),
    note,
  };

  const pending = snapshot.obligations.filter(o => o.status === 'pending');
  if (pending.length) return { ok: false, reason: `还有 ${pending.length} 项义务未交付材料` };

  batch.frozenBasis = snapshot;
  batch.status = 'frozen';
  audit(state, 'batch.freeze', `批次「${batch.name}」v${batch.version} 冻结，固定 ${snapshot.sources.length} 个来源、${snapshot.obligations.length} 项义务的依据`, batch.id);
  return { ok: true };
}

// ---------- 双负责人确认：先到形成版本，后到保留材料并列差异 ----------

function diffMaterials(batch: Batch, winner: Confirmation, later: Confirmation): MaterialDiffEntry[] {
  const basis = batch.frozenBasis!;
  const keys = new Set([...Object.keys(winner.materials), ...Object.keys(later.materials), ...basis.obligations.map(o => o.key)]);
  const out: MaterialDiffEntry[] = [];
  for (const key of [...keys].sort()) {
    const ob = basis.obligations.find(o => o.key === key);
    const w = winner.materials[key];
    const l = later.materials[key];
    const verdict: MaterialDiffEntry['verdict'] =
      w !== undefined && l !== undefined ? (w === l ? 'same' : 'changed')
        : w !== undefined ? 'only-winner'
          : 'only-later';
    out.push({ obKey: key, label: ob ? `${ob.fingerprint} · ${OBLIGATION_LABEL[ob.type]}` : key, winner: w, later: l, verdict });
  }
  return out;
}

export function confirmBatch(
  state: AppState,
  batchId: string,
  owner: string,
  materials: Record<string, string>,
  idemKey: string,
): { confirmation: Confirmation; role: 'duplicate' | 'winner' | 'later'; diff?: MaterialDiffEntry[] } | { error: string } {
  const batch = state.batches.find(b => b.id === batchId);
  if (!batch) return { error: '批次不存在' };
  if (batch.status !== 'frozen' && batch.status !== 'confirmed') return { error: '批次尚未冻结，不能确认' };
  if (!consumeIdem(state, idemKey)) {
    const existing = batch.confirmations.find(c => c.idemKey === idemKey)!;
    return { confirmation: existing, role: 'duplicate' };
  }

  const existingMine = batch.confirmations.find(c => c.owner === owner);
  const winner = batch.confirmations.find(c => c.winner);

  // 后到者再次提交：更新保留材料并重算差异
  if (existingMine && !existingMine.winner && winner) {
    existingMine.materials = materials;
    existingMine.at = Date.now();
    existingMine.diff = diffMaterials(batch, winner, existingMine);
    const changed = existingMine.diff.filter(d => d.verdict === 'changed' || d.verdict === 'only-later').length;
    audit(state, 'confirm.update-later', `${owner} 更新保留材料，与先到版本差异 ${changed} 项；冻结依据不变`, batch.id);
    return { confirmation: existingMine, role: 'later', diff: existingMine.diff };
  }
  if (existingMine && existingMine.winner) {
    return { confirmation: existingMine, role: 'duplicate' };
  }

  const confirmation: Confirmation = { idemKey, owner, at: Date.now(), winner: !winner, materials };
  if (!winner) {
    batch.confirmations.push(confirmation);
    batch.status = 'confirmed';
    audit(state, 'confirm.winner', `${owner} 首先确认，批次「${batch.name}」v${batch.version} 形成发布版本`, batch.id);
    return { confirmation, role: 'winner' };
  }

  confirmation.diff = diffMaterials(batch, winner, confirmation);
  batch.confirmations.push(confirmation);
  const changed = confirmation.diff.filter(d => d.verdict === 'changed' || d.verdict === 'only-later').length;
  audit(state, 'confirm.later', `${owner} 的确认晚到，材料已保留，相对先到版本列出 ${changed} 项差异；批次仍以先到版本为准`, batch.id);
  return { confirmation, role: 'later', diff: confirmation.diff };
}

/** 依据后到者材料另开新版本：历史版本完整保留 */
export function reopenAsNewVersion(state: AppState, batchId: string): Batch | undefined {
  const old = state.batches.find(b => b.id === batchId);
  if (!old || !old.frozenBasis || old.status !== 'confirmed') return undefined;
  const later = old.confirmations.find(c => !c.winner);

  const batch: Batch = {
    id: nextId(state, 'b'),
    name: old.name,
    version: old.version + 1,
    status: 'open',
    artifactIds: [...old.artifactIds],
    processedArtifacts: [],
    scopeSig: {},
    obligations: [],
    confirmations: [],
    reportKeys: [],
    createdAt: Date.now(),
  };
  state.batches.push(batch);

  const next = computeScope(state, batch);
  reconcile(state, batch, next, true);

  // 后到者保留的材料作为初稿带入（旧批次 key 带旧批次号，按 来源:类型 映射），仍需重新核对确认
  if (later) {
    const suffixOf = (key: string) => key.split(':').slice(1).join(':');
    for (const ob of batch.obligations) {
      const match = Object.entries(later.materials).find(([k]) => suffixOf(k) === suffixOf(ob.key));
      if (match) {
        ob.evidence = `沿用 ${later.owner} 保留材料：${match[1]}`;
        ob.owner = later.owner;
      }
    }
  }

  audit(state, 'batch.reopen', `依据后到确认材料把「${old.name}」另开为 v${batch.version}，原 v${old.version} 冻结记录保留`, batch.id);
  return batch;
}

// ---------- 报告 ----------

export interface ReportBlocker {
  code: 'legacy' | 'unknown-license' | 'pending' | 'interrupted' | 'not-confirmed';
  message: string;
}

export interface ReleaseReport {
  batchId: string;
  name: string;
  version: number;
  basisNote: string;
  frozenAt?: number;
  sections: Array<{ type: ObligationType; fingerprint: string; name: string; basis: string; material: string; evidence?: string }>;
  blockers: ReportBlocker[];
  canPublish: boolean;
}

export function buildReport(state: AppState, batchId: string): ReleaseReport {
  const batch = state.batches.find(b => b.id === batchId)!;
  const blockers: ReportBlocker[] = [];
  const scopeIds = new Set<string>();
  for (const aid of batch.artifactIds) for (const id of state.artifacts[aid]?.sourceIds ?? []) scopeIds.add(resolveSourceId(state, id));

  if (state.sources.some(s => !s.fingerprint && scopeIds.has(s.id))) {
    blockers.push({ code: 'legacy', message: '范围内存在无来源指纹的旧数据，请先完成迁移' });
  }
  const unknown = state.sources.filter(
    s => scopeIds.has(s.id) && s.fingerprint && s.refs.some(r => !r.removed) && requiredObligations(s.license, true).length === 0,
  );
  if (unknown.length) {
    blockers.push({ code: 'unknown-license', message: `许可证待补全：${unknown.map(s => s.name).join('、')}` });
  }
  if (batch.interruptedAt) blockers.push({ code: 'interrupted', message: '清单处理曾中断且尚未续跑完成' });
  const pendingLive = batch.status === 'open' ? batch.obligations.filter(o => o.status === 'pending') : [];
  if (pendingLive.length) {
    blockers.push({ code: 'pending', message: `${pendingLive.length} 项义务尚未交付材料` });
  }
  if (batch.status !== 'confirmed') {
    blockers.push({ code: 'not-confirmed', message: batch.status === 'frozen' ? '批次已冻结但两位负责人尚未完成确认' : '批次未冻结确认' });
  }

  // 报告依据：冻结后只看快照；开放批次看实时义务（撤下片段不会再出现署名 / 源码链接）
  const basisObligations = batch.frozenBasis ? batch.frozenBasis.obligations : batch.obligations;
  const nameOf = (sid: string) =>
    batch.frozenBasis?.sources.find(s => s.id === sid)?.name ?? state.sources.find(s => s.id === sid)?.name ?? sid;

  const sections = basisObligations
    .filter(o => o.status !== 'withdrawn')
    .map(o => ({
      type: o.type,
      fingerprint: o.fingerprint,
      name: nameOf(o.sourceId),
      basis: o.basis,
      material: o.material,
      evidence: o.evidence,
    }));

  return {
    batchId,
    name: batch.name,
    version: batch.version,
    basisNote: batch.frozenBasis?.note || '开放批次：依据随范围实时重算，冻结后固定',
    frozenAt: batch.frozenBasis?.frozenAt,
    sections,
    blockers,
    canPublish: blockers.length === 0,
  };
}

/** 出具报告：幂等，重试不重复写审计 */
export function issueReport(state: AppState, batchId: string, idemKey: string): ReleaseReport | { error: string; report: ReleaseReport } {
  const report = buildReport(state, batchId);
  if (!report.canPublish) return { error: '存在未处理义务，报告不可发布', report };
  const batch = state.batches.find(b => b.id === batchId)!;
  if (batch.reportKeys.includes(idemKey)) {
    audit(state, 'report.idem-skip', `报告请求 ${idemKey} 重试，沿用已出具版本`, batch.id, idemKey);
    return report;
  }
  batch.reportKeys.push(idemKey);
  audit(state, 'report.issue', `出具「${report.name}」v${report.version} 可发布报告，含 ${report.sections.length} 项署名 / 源码 / 修改披露条目`, batch.id, idemKey);
  return report;
}
