import {
  AppState, AuditEntry, Batch, ConfirmationAttempt, DiffEntry, JobStep, Obligation,
  ObligationKind, Release, SourceRecord, SourceRef, WriteJob,
} from '../types';

// ---------- 基础 ----------

let counter = 0;
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

/** 53 位摘要，用于冻结依据与确认材料比对（非密码学场景足够）。
 *  参与比较的结构均以相同键序构造（冻结快照 / 其克隆），普通序列化即可稳定复现。 */
export function digest(obj: unknown): string {
  const json = JSON.stringify(obj);
  let h1 = 0xdeadbeef ^ 0, h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < json.length; i++) {
    const ch = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(13, '0');
}

export function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

// ---------- 许可义务规则（按指纹生成，与发布物无关） ----------

const PERMISSIVE = new Set(['MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Apache-2.0']);
const COPYLEFT = new Set(['GPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'MPL-2.0', 'EPL-2.0', 'CDDL-1.0']);
const CHANGE_NOTICE = new Set(['Apache-2.0', 'GPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'MPL-2.0', 'EPL-2.0']);

export function obligationKinds(license: string, modified: boolean): ObligationKind[] {
  const kinds: ObligationKind[] = ['attribution']; // 任何保留型许可至少要署名；未知许可从严
  if (COPYLEFT.has(license)) kinds.push('sourceOffer');
  if (modified && CHANGE_NOTICE.has(license)) kinds.push('modDisclosure');
  return kinds;
}

function obligationDetail(kind: ObligationKind, ref: SourceRef): string {
  const holder = ref.name;
  const where = '见来源登记';
  switch (kind) {
    case 'attribution':
      return `在发布物的声明文件中保留 ${holder}（${ref.license}）的版权声明与许可全文`;
    case 'sourceOffer':
      return `${ref.license} 要求随本发布物提供对应完整源代码（${where}）`;
    case 'modDisclosure':
      return `该来源存在修改，须按 ${ref.license} 在发布物中显著披露修改内容与日期`;
  }
}

/** 单个来源指纹 → 义务集合；键 = 指纹×类型，跨重算稳定 */
export function deriveObligations(ref: SourceRef, now: number): Obligation[] {
  return obligationKinds(ref.license, ref.modified).map((kind) => ({
    key: `${ref.fingerprint}:${kind}`,
    sourceFingerprint: ref.fingerprint,
    sourceName: ref.name,
    kind,
    license: ref.license,
    detail: obligationDetail(kind, ref),
    status: 'pending',
    basisFingerprint: ref.fingerprint,
    updatedAt: now,
  }));
}

// ---------- 指纹归并 ----------

export function toRef(rec: SourceRecord): SourceRef {
  return {
    fingerprint: rec.fingerprint!,
    recordId: rec.id,
    name: rec.name,
    version: rec.version,
    license: rec.license,
    kind: rec.kind,
    modified: rec.modified,
  };
}

/** 同一指纹的多条记录归并为一个代表 ref（义务只算一份） */
export function mergeByFingerprint(records: SourceRecord[]): Map<string, { ref: SourceRef; count: number }> {
  const map = new Map<string, { ref: SourceRef; count: number }>();
  for (const rec of records) {
    if (!rec.fingerprint) continue; // 未迁移旧数据不进入任何发布物
    const cur = map.get(rec.fingerprint);
    if (cur) cur.count += 1;
    else map.set(rec.fingerprint, { ref: toRef(rec), count: 1 });
  }
  return map;
}

// ---------- 发布物：范围变化 → 只重算受影响义务 ----------

export function createRelease(state: AppState, label: string, now: number): Release {
  return {
    id: uid('rel'),
    label,
    status: 'draft',
    scopeFingerprints: [],
    refs: [],
    obligations: [],
    changes: { added: [], removed: [] },
    createdAt: now,
    updatedAt: now,
  };
}

function releaseInFrozenBatch(state: AppState, releaseId: string): boolean {
  return state.batches.some(
    (b) => (b.state === 'frozen' || b.state === 'confirmed') && b.releaseIds.includes(releaseId),
  );
}

/**
 * 增量重算：对比新旧范围，只重算受影响指纹的署名/源码交付/修改披露；
 * 未变指纹上的义务（含完成状态、证据）按键原样保留。
 * 已冻结批次引用的发布物禁止重算（冻结依据不可变）。
 */
export function recomputeRelease(state: AppState, releaseId: string, now: number): AppState {
  const next = clone(state);
  const release = next.releases.find((r) => r.id === releaseId);
  if (!release || releaseInFrozenBatch(next, releaseId)) return state;

  const before = new Map(release.refs.map((r) => [r.fingerprint, r]));

  const inScope = next.sources.filter(
    (s) => s.fingerprint && release.scopeFingerprints.includes(s.fingerprint) && !s.legacy,
  );
  const grouped = mergeByFingerprint(inScope);
  const refs = [...grouped.values()].map((g) => g.ref);
  const after = new Map(refs.map((r) => [r.fingerprint, r]));

  const added: string[] = [];
  const removed: Release['changes']['removed'] = [];
  for (const fp of after.keys()) if (!before.has(fp)) added.push(fp);
  for (const [fp, ref] of before) if (!after.has(fp)) removed.push({ fingerprint: fp, name: ref.name, at: now });

  // 仅对受影响指纹重算；保留键相同义务的履行状态/证据
  const oldByKey = new Map(release.obligations.map((o) => [o.key, o]));
  const obligations: Obligation[] = [];
  for (const ref of refs) {
    const affected = added.includes(ref.fingerprint)
      || removed.some((r) => r.fingerprint === ref.fingerprint)
      || !before.has(ref.fingerprint);
    for (const fresh of deriveObligations(ref, now)) {
      const old = oldByKey.get(fresh.key);
      if (old && !affected) {
        obligations.push(old); // 范围未变 → 原义务（含已完成状态）不动
      } else if (old) {
        // 指纹仍在但来源元数据可能变化：重算内容，保留履行证据
        obligations.push({
          ...fresh,
          status: old.status,
          evidence: old.evidence,
          satisfiedAt: old.satisfiedAt,
        });
      } else {
        obligations.push(fresh);
      }
    }
  }

  // 被撤下来源：其署名/源码链接义务随之消失（冻结批次的快照里仍保留原依据）
  release.refs = refs;
  release.obligations = obligations;
  release.changes = {
    added: added.length || removed.length ? added : release.changes.added,
    removed: removed.length ? [...release.changes.removed, ...removed] : release.changes.removed,
  };
  release.status = releaseReady(next, releaseId) ? 'ready' : 'draft';
  release.updatedAt = now;
  return next;
}

export function setScope(state: AppState, releaseId: string, fingerprints: string[], now: number): AppState {
  const next = clone(state);
  const release = next.releases.find((r) => r.id === releaseId);
  if (!release) return state;
  release.scopeFingerprints = [...new Set(fingerprints)].filter(
    (fp) => next.sources.some((s) => s.fingerprint === fp && !s.legacy),
  );
  return recomputeRelease(next, releaseId, now);
}

export function toggleScope(state: AppState, releaseId: string, fingerprint: string, now: number): AppState {
  const release = state.releases.find((r) => r.id === releaseId);
  if (!release) return state;
  const has = release.scopeFingerprints.includes(fingerprint);
  const fps = has
    ? release.scopeFingerprints.filter((f) => f !== fingerprint)
    : [...release.scopeFingerprints, fingerprint];
  return setScope(state, releaseId, fps, now);
}

export function setObligationEvidence(
  state: AppState, releaseId: string, key: string, evidence: string, now: number,
): AppState {
  const next = clone(state);
  const release = next.releases.find((r) => r.id === releaseId);
  const obl = release?.obligations.find((o) => o.key === key);
  if (!release || !obl || releaseInFrozenBatch(next, releaseId)) return state;
  obl.evidence = evidence;
  obl.status = 'satisfied';
  obl.satisfiedAt = now;
  obl.updatedAt = now;
  release.status = releaseReady(next, releaseId) ? 'ready' : 'draft';
  release.updatedAt = now;
  return next;
}

/** 可发布判据：范围非空，且没有未处理义务（未迁移来源根本无法进入范围） */
export function releaseReady(state: AppState, releaseId: string): boolean {
  const r = state.releases.find((x) => x.id === releaseId);
  if (!r || r.refs.length === 0) return false;
  return r.obligations.every((o) => o.status === 'satisfied');
}

// ---------- 批次：冻结原依据 ----------

export function createBatch(state: AppState, name: string, releaseIds: string[], now: number): AppState | string {
  if (releaseIds.length === 0) return '批次至少包含一个发布物';
  for (const id of releaseIds) {
    if (!releaseReady(state, id)) return `发布物存在未处理义务，不能进批次：${state.releases.find((r) => r.id === id)?.label ?? id}`;
    if (state.batches.some((b) => b.releaseIds.includes(id))) return `发布物已属于其它批次，不能重复纳入：${state.releases.find((r) => r.id === id)?.label ?? id}`;
  }
  const next = clone(state);
  const batch: Batch = {
    id: uid('batch'),
    name,
    state: 'open',
    releaseIds,
    confirmations: [],
    createdAt: now,
  };
  next.batches.push(batch);
  return next;
}

export function freezeBatch(state: AppState, batchId: string, now: number): AppState {
  const next = clone(state);
  const batch = next.batches.find((b) => b.id === batchId);
  if (!batch || batch.state !== 'open') return state;
  const snapshotReleases = batch.releaseIds.map((rid) => {
    const r = next.releases.find((x) => x.id === rid)!;
    return { releaseId: r.id, label: r.label, refs: clone(r.refs), obligations: clone(r.obligations) };
  });
  batch.frozen = { frozenAt: now, reportDigest: digest(snapshotReleases), releases: snapshotReleases };
  batch.state = 'frozen';
  next.audit.push({
    id: uid('aud'), ts: now, action: 'batch-frozen',
    detail: `批次「${batch.name}」冻结 ${snapshotReleases.length} 个发布物，依据摘要 ${batch.frozen.reportDigest.slice(0, 8)}`,
    batchId,
  });
  return next;
}

// ---------- 双重确认：先到形成版本，后到保留材料并列差异 ----------

export interface ConfirmMaterial {
  owner: string;
  note: string;
  releaseIds: string[];
  releases: { releaseId: string; label: string; refs: SourceRef[]; obligations: Obligation[] }[];
}

function diffMaterial(winner: ConfirmMaterial, late: ConfirmMaterial, frozenDigest: string): DiffEntry[] {
  const diffs: DiffEntry[] = [];
  const lateDigest = digest(late.releases);
  if (lateDigest !== frozenDigest) {
    diffs.push({
      type: 'digest', subject: '整包材料摘要',
      winner: frozenDigest.slice(0, 10), late: lateDigest.slice(0, 10),
    });
  }
  const wIds = new Set(winner.releaseIds);
  const lIds = new Set(late.releaseIds);
  for (const id of wIds) if (!lIds.has(id)) diffs.push({ type: 'release-missing', subject: id, winner: id, late: '缺失' });
  for (const id of lIds) if (!wIds.has(id)) diffs.push({ type: 'release-extra', subject: id, winner: '无', late: id });
  for (const wr of winner.releases) {
    const lr = late.releases.find((x) => x.releaseId === wr.releaseId);
    if (!lr) continue;
    const wObl = new Map(wr.obligations.map((o) => [o.key, o]));
    const lObl = new Map(lr.obligations.map((o) => [o.key, o]));
    for (const [key, wo] of wObl) {
      const lo = lObl.get(key);
      const wSig = `${wo.status}:${wo.evidence ?? ''}`;
      const lSig = lo ? `${lo.status}:${lo.evidence ?? ''}` : '缺失';
      if (wSig !== lSig) {
        diffs.push({ type: 'obligation', subject: `${wr.label} / ${wo.sourceName} / ${wo.kind}`, winner: wSig, late: lSig });
      }
    }
  }
  return diffs;
}

export function confirmBatch(
  state: AppState, batchId: string, material: ConfirmMaterial, now: number,
): AppState {
  const next = clone(state);
  const batch = next.batches.find((b) => b.id === batchId);
  // frozen：等待首个（先到）确认；confirmed：只接受后到补交，版本不再改变
  if (!batch || (batch.state !== 'frozen' && batch.state !== 'confirmed') || !batch.frozen) return state;

  const materialDigest = digest(material.releases);
  if (!batch.winnerAttemptId) {
    // 先到者：形成版本（以冻结依据为准，记录其材料一致性）
    const attempt: ConfirmationAttempt = {
      id: uid('cfm'), owner: material.owner, receivedAt: now, role: 'winner',
      materialDigest, materialReleaseIds: material.releaseIds, note: material.note,
    };
    batch.confirmations.push(attempt);
    batch.winnerAttemptId = attempt.id;
    batch.state = 'confirmed';
    next.audit.push({
      id: uid('aud'), ts: now, action: 'confirm-winner',
      detail: `${material.owner} 首先确认批次「${batch.name}」，形成发布版本；材料与冻结依据${materialDigest === batch.frozen.reportDigest ? '一致' : '不一致（以冻结版为准）'}`,
      batchId,
    });
    return next;
  }

  // 后到者：材料原样保留，只列出与先到版本的差异，绝不覆盖
  const winner = batch.confirmations.find((c) => c.id === batch.winnerAttemptId)!;
  const winnerMaterial: ConfirmMaterial = {
    owner: winner.owner, note: winner.note,
    releaseIds: winner.materialReleaseIds,
    releases: clone(batch.frozen.releases),
  };
  const attempt: ConfirmationAttempt = {
    id: uid('cfm'), owner: material.owner, receivedAt: now, role: 'late',
    materialDigest, materialReleaseIds: material.releaseIds, note: material.note,
    diff: diffMaterial(winnerMaterial, material, batch.frozen.reportDigest),
  };
  batch.confirmations.push(attempt);
  next.audit.push({
    id: uid('aud'), ts: now, action: 'confirm-late-retained',
    detail: `${material.owner} 的确认晚到，材料已保留并列出 ${attempt.diff?.length ?? 0} 项差异；版本仍以 ${winner.owner} 的先到确认为准`,
    batchId,
  });
  return next;
}

/** 基于后到者保留的材料构造确认提交（演示用：可故意改一个义务状态制造差异） */
export function buildMaterialFromBatch(state: AppState, batch: Batch, owner: string, note: string, tamperReleaseId?: string): ConfirmMaterial {
  const releases = clone(batch.frozen!.releases);
  if (tamperReleaseId) {
    const r = releases.find((x) => x.releaseId === tamperReleaseId);
    if (r && r.obligations[0]) {
      r.obligations[0] = { ...r.obligations[0], status: 'pending', evidence: undefined };
    }
  }
  return { owner, note, releaseIds: releases.map((r) => r.releaseId), releases };
}

// ---------- 写入作业：幂等步骤 + 断点续作 ----------

export function createWriteJob(state: AppState, batchId: string, now: number): AppState | string {
  const batch = state.batches.find((b) => b.id === batchId);
  if (!batch || batch.state !== 'confirmed' || !batch.frozen) return '只有已确认批次才能创建写入作业';
  if (state.jobs.some((j) => j.batchId === batchId && j.state !== 'complete')) return '该批次已有进行中的写入作业';

  const steps: JobStep[] = [];
  for (const rel of batch.frozen.releases) {
    steps.push({
      idempotencyKey: `write:${batchId}:${rel.releaseId}:scope-snapshot`,
      releaseId: rel.releaseId, kind: 'scope-snapshot', title: `${rel.label} · 范围快照（冻结依据）`,
      state: 'pending', attempts: 0,
    });
    for (const obl of rel.obligations) {
      steps.push({
        idempotencyKey: `write:${batchId}:${rel.releaseId}:${obl.kind}:${obl.sourceFingerprint}`,
        releaseId: rel.releaseId,
        kind: obl.kind,
        title: `${rel.label} · ${obl.sourceName} · ${obl.kind}`,
        state: 'pending', attempts: 0,
      });
    }
    steps.push({
      idempotencyKey: `write:${batchId}:${rel.releaseId}:report`,
      releaseId: rel.releaseId, kind: 'report', title: `${rel.label} · 生成发布报告`,
      state: 'pending', attempts: 0,
    });
    steps.push({
      idempotencyKey: `write:${batchId}:${rel.releaseId}:release-audit`,
      releaseId: rel.releaseId, kind: 'release-audit', title: `${rel.label} · 封存发布审计`,
      state: 'pending', attempts: 0,
    });
  }

  const next = clone(state);
  const job: WriteJob = { id: uid('job'), batchId, steps, state: 'running', startedAt: now };
  next.jobs.push(job);
  return next;
}

/**
 * 推进一步（可模拟崩溃）。
 * 从第一个未完成步骤继续——它必然属于最后一个完整发布物之后的发布物；
 * 已完成步骤（义务写入/审计）按键跳过，重试绝不重复生成。
 */
export function advanceJob(state: AppState, jobId: string, now: number, crash = false): AppState {
  const next = clone(state);
  const job = next.jobs.find((j) => j.id === jobId);
  if (!job || job.state === 'complete') return state;

  job.state = 'running';
  const step = job.steps.find((s) => s.state === 'pending');
  if (!step) {
    job.state = 'complete';
    job.finishedAt = now;
    return next;
  }

  step.attempts += 1;
  if (crash) {
    // 写入中断：步骤未完成，作业挂起；已完成步骤与审计不受影响
    job.state = 'interrupted';
    return next;
  }

  step.state = 'done';
  step.doneAt = now;

  // 审计按幂等键去重：即使步骤被重复执行，也只产生一条审计记录
  if (!next.audit.some((a) => a.idempotencyKey === step.idempotencyKey)) {
    const actionMap: Record<JobStep['kind'], string> = {
      'scope-snapshot': 'scope-snapshot',
      attribution: 'obligation-attribution',
      sourceOffer: 'obligation-source-offer',
      modDisclosure: 'obligation-mod-disclosure',
      report: 'report-generated',
      'release-audit': 'release-audit-sealed',
    };
    const entry: AuditEntry = {
      id: uid('aud'), idempotencyKey: step.idempotencyKey, ts: now,
      action: actionMap[step.kind], detail: step.title,
      releaseId: step.releaseId, batchId: job.batchId,
    };
    next.audit.push(entry);
  } else {
    step.state = 'skipped-duplicate';
  }

  if (!job.steps.some((s) => s.state === 'pending')) {
    job.state = 'complete';
    job.finishedAt = now;
    next.audit.push({
      id: uid('aud'), ts: now, action: 'write-job-complete',
      detail: `写入作业完成：${job.steps.filter((s) => s.state === 'done').length} 个步骤`,
      batchId: job.batchId,
    });
  }
  return next;
}

/** 标记中断（模拟写入过程中断电/断网） */
export function interruptJob(state: AppState, jobId: string): AppState {
  const next = clone(state);
  const job = next.jobs.find((j) => j.id === jobId);
  if (job && job.state === 'running') job.state = 'interrupted';
  return next;
}

export function lastCompleteReleaseIndex(job: WriteJob): number {
  // 最后一个「审计已封存」的发布物下标；续作从其后一个发布物开始
  let last = -1;
  const order: string[] = [];
  for (const s of job.steps) {
    const idx = order.indexOf(s.releaseId);
    if (idx === -1) order.push(s.releaseId);
    if (s.kind === 'release-audit' && s.state === 'done') last = order.indexOf(s.releaseId);
  }
  return last;
}

// ---------- 旧数据迁移：补齐来源指纹 ----------

export function migrationPending(state: AppState): SourceRecord[] {
  return state.sources.filter((s) => !s.fingerprint);
}

/**
 * 指纹迁移：旧数据没有指纹时，先逐批补齐；同指纹记录归并。
 * 迁移完成前，遗留来源无法加入发布物范围（未处理义务不进可发布报告）。
 */
export function migrateFingerprints(
  state: AppState, assignments: { id: string; fingerprint: string }[], now: number,
): AppState {
  const next = clone(state);
  for (const a of assignments) {
    const rec = next.sources.find((s) => s.id === a.id);
    if (!rec || rec.fingerprint) continue;
    const canonical = next.sources.find((s) => s.fingerprint === a.fingerprint && s.id !== rec.id);
    rec.fingerprint = a.fingerprint;
    rec.legacy = false;
    rec.migratedAt = now;
    if (canonical) {
      canonical.mergedFrom = [...(canonical.mergedFrom ?? []), rec.id];
    }
  }
  const remaining = next.sources.filter((s) => !s.fingerprint).length;
  next.migration = { running: remaining > 0, done: next.sources.length - remaining, total: next.sources.length };
  if (remaining === 0) {
    next.audit.push({
      id: uid('aud'), ts: now, action: 'migration-complete',
      detail: `旧数据来源指纹迁移完成，共 ${assignments.length} 条，重复来源已按指纹归并`,
    });
  }
  return next;
}

export function startMigration(state: AppState): AppState {
  const next = clone(state);
  const pending = migrationPending(next).length;
  next.migration = { running: pending > 0, done: next.migration.done, total: next.sources.length };
  return next;
}
