import { createHash } from 'crypto';
import { AppState, SourceRecord } from '../src/types';
import {
  advanceJob, buildMaterialFromBatch, clone, confirmBatch, createBatch, createRelease,
  createWriteJob, deriveObligations, freezeBatch, lastCompleteReleaseIndex,
  mergeByFingerprint, migrateFingerprints, recomputeRelease, releaseReady,
  setObligationEvidence, setScope, toRef,
} from '../src/lib/engine';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};
const eq = (name: string, a: unknown, b: unknown) => ok(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, JSON.stringify(a) === JSON.stringify(b));

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const dep = (name: string, version: string, license: string, modified = false): SourceRecord => ({
  id: `src_${name}`, fingerprint: sha(`dep:${name}@${version}`), kind: 'dependency',
  name, version, license, modified, addedAt: 0,
});
const snip = (name: string, code: string, license = 'MIT', modified = false): SourceRecord => ({
  id: `src_${name}`, fingerprint: sha(`snippet:${code.replace(/\s+/g, ' ').trim()}`), kind: 'snippet',
  name, license, code, modified, addedAt: 0,
});

const base = (sources: SourceRecord[]): AppState => ({
  bootstrapped: true, sources, releases: [], batches: [], jobs: [], audit: [],
  migration: { running: false, done: sources.length, total: sources.length }, seq: 1,
});
const T = 1_700_000_000_000;

// 1) 指纹归并：同片段两处登记只产生一份义务
{
  const code = 'function f(){return 1}';
  const s = base([snip('a', code), snip('b', code), dep('react', '18.0.0', 'MIT')]);
  const g = mergeByFingerprint(s.sources);
  eq('同指纹两条片段记录归并为 1 个来源', g.size, 2);
  const snipFp = s.sources[0].fingerprint!;
  eq('归并组记录数为 2', g.get(snipFp)!.count, 2);
  eq('每个来源义务只生成一份', deriveObligations(toRef(s.sources[0]), T).length, 1);
}

// 2) 增量重算：只动受影响指纹；未变义务（含证据）保留
{
  let s = base([dep('react', '18.0.0', 'MIT'), dep('gplx', '1.0.0', 'GPL-3.0', true)]);
  const r = createRelease(s, 'R', T); s.releases.push(r);
  const fps = s.sources.map((x) => x.fingerprint!);
  s = setScope(s, r.id, fps, T + 1);
  const reactOblKey = `${s.sources[0].fingerprint}:attribution`;
  s = setObligationEvidence(s, r.id, reactOblKey, 'NOTICE §1', T + 2);
  const beforeRel = clone(s.releases[0]);
  const beforeReact = beforeRel.obligations.find((o) => o.key === reactOblKey)!;

  // 加入一个新来源 → react 的义务对象原样保留
  s.sources.push(dep('lodash', '4.0.0', 'MIT'));
  s = setScope(s, r.id, [...fps, s.sources[2].fingerprint!], T + 3);
  const afterReact = s.releases[0].obligations.find((o) => o.key === reactOblKey)!;
  ok('加入来源时未变义务保留证据与履行状态',
    afterReact.evidence === beforeReact.evidence && afterReact.status === beforeReact.status
    && afterReact.satisfiedAt === beforeReact.satisfiedAt && afterReact.updatedAt === beforeReact.updatedAt);
  eq('新增来源带来新增义务', s.releases[0].obligations.length, beforeRel.obligations.length + 1);
  eq('changes.added 记录新指纹', s.releases[0].changes.added.length, 1);

  // 撤下 GPL 依赖 → 其署名/源码/修改披露全部移除；react 不动
  s = setScope(s, r.id, [s.sources[0].fingerprint!, s.sources[2].fingerprint!], T + 4);
  const gplKeys = s.releases[0].obligations.filter((o) => o.sourceName === 'gplx');
  eq('撤下来源后其全部义务消失', gplKeys.length, 0);
  ok('撤下后其它义务仍在', s.releases[0].obligations.some((o) => o.key === reactOblKey));
  eq('撤下事件进入 changes.removed', s.releases[0].changes.removed.some((x) => x.name === 'gplx'), true);
}

// 3) 冻结批次保留原依据：冻结后重算/撤下均不改快照
{
  let s = base([dep('react', '18.0.0', 'MIT'), dep('lodash', '4.0.0', 'MIT')]);
  const r = createRelease(s, 'R', T); s.releases.push(r);
  s = setScope(s, r.id, s.sources.map((x) => x.fingerprint!), T + 1);
  for (const o of s.releases[0].obligations) s = setObligationEvidence(s, r.id, o.key, 'ev', T + 2);
  const mb = createBatch(s, 'B', [r.id], T + 3) as AppState; s = mb;
  const bid = s.batches[0].id;
  s = freezeBatch(s, bid, T + 4);
  const frozenDigest = s.batches[0].frozen!.reportDigest;

  // 冻结后从发布物撤下 lodash 并尝试重算
  s = setScope(s, r.id, [s.sources[0].fingerprint!], T + 5);
  const rel = s.releases.find((x) => x.id === r.id)!;
  eq('已冻结发布物范围不被改写', rel.refs.length, 2);
  eq('冻结摘要保持不变', s.batches[0].frozen!.reportDigest, frozenDigest);
  eq('冻结快照仍含撤下来源的署名', s.batches[0].frozen!.releases[0].obligations.some((o) => o.sourceName === 'lodash'), true);
}

// 4) 双确认：先到形成版本；后到保留材料 + 差异，且不覆盖
{
  let s = base([dep('react', '18.0.0', 'MIT'), dep('g', '1.0.0', 'GPL-3.0')]);
  const r = createRelease(s, 'R', T); s.releases.push(r);
  s = setScope(s, r.id, s.sources.map((x) => x.fingerprint!), T + 1);
  for (const o of s.releases[0].obligations) s = setObligationEvidence(s, r.id, o.key, 'ev', T + 2);
  s = createBatch(s, 'B', [r.id], T + 3) as AppState;
  const bid = s.batches[0].id;
  s = freezeBatch(s, bid, T + 4);

  const win = buildMaterialFromBatch(s, s.batches[0], 'A', 'ok');
  s = confirmBatch(s, bid, win, T + 5);
  eq('先到确认后批次为 confirmed', s.batches[0].state, 'confirmed');

  // 后到材料：把第一项义务改为未履行
  const late = buildMaterialFromBatch(s, s.batches[0], 'B', 'miss', r.id);
  s = confirmBatch(s, bid, late, T + 6);
  const b = s.batches[0];
  eq('两次确认均保留', b.confirmations.length, 2);
  eq('后到角色为 late', b.confirmations[1].role, 'late');
  ok('后到材料存在义务差异', (b.confirmations[1].diff?.length ?? 0) >= 1);
  ok('差异含义务类型', b.confirmations[1].diff!.some((d) => d.type === 'obligation' || d.type === 'digest'));
  eq('版本仍是先到者', b.winnerAttemptId, b.confirmations[0].id);
  // 冻结依据未被后到材料污染
  eq('冻结快照义务仍全部已履行', b.frozen!.releases[0].obligations.every((o) => o.status === 'satisfied'), true);

  // 第三次提交不产生新 winner，仍只是 late 保留
  const late2 = buildMaterialFromBatch(s, b, 'C', 'again');
  s = confirmBatch(s, bid, late2, T + 7);
  eq('第三个确认仍是 late，不覆盖版本', s.batches[0].confirmations[2].role, 'late');
}

// 5) 写入中断续作 + 幂等
{
  let s = base([dep('react', '18.0.0', 'MIT'), dep('lodash', '4.0.0', 'MIT')]);
  const r1 = createRelease(s, 'R1', T); s.releases.push(r1);
  s = setScope(s, r1.id, [s.sources[0].fingerprint!], T + 1);
  for (const o of s.releases[0].obligations) s = setObligationEvidence(s, r1.id, o.key, 'ev', T + 2);
  const r2 = createRelease(s, 'R2', T + 3); s.releases.push(r2);
  s = setScope(s, r2.id, [s.sources[1].fingerprint!], T + 4);
  for (const o of s.releases.find((x) => x.id === r2.id)!.obligations) s = setObligationEvidence(s, r2.id, o.key, 'ev', T + 5);

  s = createBatch(s, 'B', [r1.id, r2.id], T + 6) as AppState;
  const bid = s.batches[0].id;
  s = freezeBatch(s, bid, T + 7);
  s = confirmBatch(s, bid, buildMaterialFromBatch(s, s.batches[0], 'A', ''), T + 8);
  s = createWriteJob(s, bid, T + 9) as AppState;
  const jid = s.jobs[0].id;
  const stepsPerRelease = 4; // 快照 + 署名(MIT 唯一义务) + 报告 + 审计
  eq('每个发布物 4 个步骤', s.jobs[0].steps.length, stepsPerRelease * 2);

  // 完成 R1 全部步骤
  for (let i = 0; i < 4; i++) s = advanceJob(s, jid, T + 10 + i);
  eq('最后一个完整发布物下标 = 0', lastCompleteReleaseIndex(s.jobs[0]), 0);

  // R2 第一步尝试两次：第一次崩溃，第二次成功
  s = advanceJob(s, jid, T + 20, true);
  eq('崩溃后作业中断', s.jobs[0].state, 'interrupted');
  const pendingStep = s.jobs[0].steps.find((x) => x.state === 'pending')!;
  eq('崩溃步骤 attempts=1 且未完成', [pendingStep.attempts, pendingStep.state], [1, 'pending']);
  const auditBefore = s.audit.length;
  s = advanceJob(s, jid, T + 21, false);
  const keys = s.audit.map((a) => a.idempotencyKey).filter(Boolean) as string[];
  eq('审计幂等键无重复', new Set(keys).size, keys.length);
  eq('重试成功只新增 1 条审计', s.audit.length - auditBefore, 1);

  // 跑完
  while (s.jobs[0].state !== 'complete') s = advanceJob(s, jid, Date.now());
  eq('作业完成', s.jobs[0].state, 'complete');
  const keysAll = s.audit.map((a) => a.idempotencyKey).filter(Boolean) as string[];
  eq('完成时步骤审计数 = 步骤数（无义务/审计重复生成）', keysAll.length, s.jobs[0].steps.length);
  eq('全部幂等键唯一', new Set(keysAll).size, keysAll.length);

  // 完成后再推一步是空操作
  const n = s.audit.length;
  s = advanceJob(s, jid, Date.now());
  eq('完成后推进不产生新记录', s.audit.length, n);
}

// 6) 未处理义务不进批次/不可发布
{
  let s = base([dep('g', '1.0.0', 'GPL-3.0', true)]);
  const r = createRelease(s, 'R', T); s.releases.push(r);
  s = setScope(s, r.id, s.sources.map((x) => x.fingerprint!), T + 1);
  eq('存在 pending 义务时不可发布', releaseReady(s, r.id), false);
  const res = createBatch(s, 'B', [r.id], T + 2);
  ok('未处理义务阻止组建批次', typeof res === 'string');
}

// 7) 旧数据迁移：无指纹不进范围；迁移后可用，重复指纹归并
{
  const legacy: SourceRecord = {
    id: 'src_old', fingerprint: null, kind: 'dependency', name: 'moment', version: '2.0.0',
    license: 'MIT', modified: false, addedAt: 0, legacy: true,
  };
  let s = base([dep('react', '18.0.0', 'MIT'), legacy]);
  const r = createRelease(s, 'R', T); s.releases.push(r);
  s = setScope(s, r.id, [s.sources[0].fingerprint!, legacy.fingerprint as unknown as string].filter(Boolean), T + 1);
  eq('无指纹旧数据无法进入范围', s.releases[0].scopeFingerprints.length, 1);
  eq('无义务为旧数据生成', s.releases[0].obligations.some((o) => o.sourceName === 'moment'), false);
  eq('不可发布', releaseReady(s, r.id), false);

  const fp = sha('dep:moment@2.0.0');
  s = migrateFingerprints(s, [{ id: legacy.id, fingerprint: fp }], T + 2);
  eq('迁移后无遗留', s.sources.every((x) => x.fingerprint), true);
  s = recomputeRelease(s, r.id, T + 3);
  s = setScope(s, r.id, [s.sources[0].fingerprint!, fp], T + 4);
  ok('迁移后旧数据可进范围', s.releases[0].scopeFingerprints.includes(fp));
  eq('迁移后产生 moment 署名义务', s.releases[0].obligations.some((o) => o.sourceName === 'moment'), true);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
