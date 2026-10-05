import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachSources, buildReport, confirmBatch, createArtifact, createBatch, createState,
  findSource, freezeBatch, ingestSource, issueReport, migrateLegacy, provideEvidence,
  removeArtifact, reopenAsNewVersion, resolveLicense, runChecklist, withdrawRef,
} from './engine.js';
import { computeFingerprint } from './fingerprint.js';
import type { AppState } from './types.js';

const count = (s: AppState, type: string) => s.audit.filter(a => a.type === type).length;
const batchOf = (s: AppState, name: string) => s.batches.find(b => b.name === name)!;

function freshBatch() {
  const s = createState();
  const b = createBatch(s, '2026-Q4 发布');
  return { s, b };
}

test('同指纹来源按指纹归并：依赖与片段的多份副本合并为一条记录', () => {
  const s = createState();
  const a = ingestSource(s, { kind: 'dependency', name: 'Lodash', version: '4.17.21', upstream: 'https://registry.npmjs.org/lodash', license: 'MIT', location: 'package.json' });
  const b = ingestSource(s, { kind: 'dependency', name: 'lodash', version: '4.17.21', upstream: 'https://registry.npmjs.org/lodash', license: 'MIT', location: 'web/package.json' });
  assert.equal(a.id, b.id, '名称大小写规范化后同一来源应归并');
  const c = ingestSource(s, { kind: 'snippet', name: 'Lodash', version: '4.17.21', upstream: 'https://registry.npmjs.org/lodash', license: 'MIT', location: 'vendor/lodash.partial.js' });
  assert.equal(c.id, a.id, '以片段形式再次引入的同一上游仍归并');
  const rec = findSource(s, a.id)!;
  assert.equal(rec.refs.length, 3, '依赖两份清单 + 片段副本，作为 3 个引用挂在同一来源下');
  // 同一位置重复登记不再新增引用
  ingestSource(s, { kind: 'dependency', name: 'lodash', version: '4.17.21', upstream: 'https://registry.npmjs.org/lodash', license: 'MIT', location: 'package.json' });
  assert.equal(findSource(s, a.id)!.refs.length, 3);
});

test('义务按 (批次,来源,类型) 稳定编号；重复推进不重复生成义务与审计', () => {
  const { s, b } = freshBatch();
  const dep = ingestSource(s, { kind: 'dependency', name: 'react', version: '18.3.1', upstream: 'npm', license: 'MIT', location: 'package.json' });
  createArtifact(s, b.id, 'web-dist', [dep.id]);
  const r1 = runChecklist(s, b.id, { idemKey: 'run-1' });
  const genAfterFirst = count(s, 'obligation.generate');
  assert.ok(r1.processedThisRun.length === 1);
  // 同键重试：空操作
  const r2 = runChecklist(s, b.id, { idemKey: 'run-1' });
  assert.deepEqual(r2.processedThisRun, []);
  assert.equal(count(s, 'obligation.generate'), genAfterFirst);
  // 新键重试：检查点显示没有新发布物，也不补审计
  const auditsBefore = s.audit.length;
  const r3 = runChecklist(s, b.id, { idemKey: 'run-2' });
  assert.deepEqual(r3.processedThisRun, []);
  assert.equal(s.audit.length, auditsBefore, '无新工作时不产生审计记录');
  const keys = b.obligations.map(o => o.key);
  assert.deepEqual([...new Set(keys)], keys, '义务编号唯一');
});

test('撤下片段后，署名/源码义务从开放批次与报告中消失，但审计留痕', () => {
  const { s, b } = freshBatch();
  const snip = ingestSource(s, { kind: 'snippet', name: 'stack-overflow-md', version: '1.0', upstream: 'https://example.com/a.md', license: 'MIT', location: 'src/utils/fmt.ts:12-40' });
  const gpl = ingestSource(s, { kind: 'dependency', name: 'readline-ng', version: '3.0', upstream: 'https://example.com/readline', license: 'GPL-3.0', location: 'package.json' });
  const art = createArtifact(s, b.id, 'web-dist', []);
  assert.ok(art);
  attachSources(s, b.id, art!.id, [snip.id, gpl.id]);
  runChecklist(s, b.id, { idemKey: 'r1' });
  assert.equal(b.obligations.filter(o => o.sourceId === snip.id && o.status === 'pending').length, 1);
  const audits = s.audit.length;
  const ref = snip.refs[0];
  withdrawRef(s, snip.id, ref.id, '片段改写为自有实现');
  const ob = b.obligations.find(o => o.sourceId === snip.id)!;
  assert.equal(ob.status, 'withdrawn');
  assert.equal(count(s, 'obligation.withdraw'), 1);
  assert.equal(s.audit.length, audits + 2, '撤下只影响该指纹：1 条撤下记录 + 1 条义务撤回，其它义务不动');
  const report = buildReport(s, b.id);
  assert.ok(!report.sections.some(x => x.fingerprint === snip.fingerprint), '撤下片段不再出现在报告署名里');
  assert.ok(report.sections.some(x => x.fingerprint === gpl.fingerprint), '未受影响来源保留');
});

test('发布物范围变化只重算受影响指纹', () => {
  const { s, b } = freshBatch();
  const d1 = ingestSource(s, { kind: 'dependency', name: 'react', version: '18.3.1', upstream: 'npm', license: 'MIT', location: 'p' });
  const d2 = ingestSource(s, { kind: 'dependency', name: 'vue', version: '3.4', upstream: 'npm', license: 'MIT', location: 'p' });
  createArtifact(s, b.id, 'a1', [d1.id]);
  createArtifact(s, b.id, 'a2', [d2.id]);
  runChecklist(s, b.id, { idemKey: 'r1' });
  const sig1 = JSON.stringify(b.scopeSig[d1.id]);
  const sig2before = JSON.stringify(b.scopeSig[d2.id]);

  const a2 = s.artifacts[b.artifactIds[1]];
  attachSources(s, b.id, a2.id, [d1.id]);
  assert.notEqual(JSON.stringify(b.scopeSig[d1.id]), sig1, 'd1 签名变化并重算');
  assert.equal(JSON.stringify(b.scopeSig[d2.id]), sig2before, 'd2 签名不变');

  // 新增“修改”属性只影响被修改来源的义务类型
  d2.refs[0].modified = true;
  attachSources(s, b.id, a2.id, []); // 触发同步但不改变组成
  // 用一次显式范围同步（由许可证编辑路径同等触发）
  resolveLicense(s, d2.id, 'MIT');
  // d2 修改后 MIT 仍只有署名（MIT 无修改披露），义务不新增
  assert.ok(!b.obligations.some(o => o.sourceId === d2.id && o.type === 'modificationDisclosure'));

  d1.refs[0].modified = true;
  resolveLicense(s, d1.id, 'Apache-2.0');
  assert.ok(b.obligations.some(o => o.sourceId === d1.id && o.type === 'modificationDisclosure' && o.status === 'pending'));
});

test('写入中断：从最后一个完整发布物继续，重试不重复义务/审计', () => {
  const { s, b } = freshBatch();
  const mk = (n: string, lic = 'MIT') => ingestSource(s, { kind: 'dependency', name: `dep-${n}`, version: '1', upstream: `u-${n}`, license: lic, location: 'p' });
  const ds = [mk('1'), mk('2'), mk('3')];
  createArtifact(s, b.id, 'art-1', [ds[0].id]);
  createArtifact(s, b.id, 'art-2', [ds[1].id]);
  createArtifact(s, b.id, 'art-3', [ds[2].id]);

  const first = runChecklist(s, b.id, { idemKey: 'run-A', failAfter: 2 });
  assert.equal(first.interrupted, true);
  assert.deepEqual(first.processedThisRun, b.artifactIds.slice(0, 2));
  assert.deepEqual(b.processedArtifacts, b.artifactIds.slice(0, 2));
  assert.equal(s.audit.filter(a => a.type === 'run.interrupted').length, 1);

  const obligationsAtInterrupt = b.obligations.map(o => ({ ...o }));
  const auditsAtInterrupt = s.audit.length;
  // 同一请求重试：续跑剩余发布物
  const retry = runChecklist(s, b.id, { idemKey: 'run-A' });
  assert.deepEqual(retry.processedThisRun, b.artifactIds.slice(2), '从最后一个完整发布物之后继续');
  assert.equal(b.interruptedAt, undefined);
  assert.equal(count(s, 'run.interrupted'), 1, '重试不再产生中断记录');
  // 已处理发布物不重复：义务集合不被重复生成（key 稳定，条数一致）
  assert.equal(b.obligations.length, obligationsAtInterrupt.length);
  assert.ok(s.audit.length > auditsAtInterrupt, '续跑为新处理的发布物补审计');
  // 再次重试：完全无新增
  const before = s.audit.length;
  const again = runChecklist(s, b.id, { idemKey: 'run-B' });
  assert.deepEqual(again.processedThisRun, []);
  assert.equal(s.audit.length, before);
});

test('已冻结批次保留原依据：之后撤下片段/改许可证不影响快照与报告', () => {
  const { s, b } = freshBatch();
  const dep = ingestSource(s, { kind: 'dependency', name: 'chart.js', version: '4.4.4', upstream: 'npm', license: 'MIT', location: 'p' });
  createArtifact(s, b.id, 'dist', [dep.id]);
  runChecklist(s, b.id, { idemKey: 'r1' });
  provideEvidence(s, b.id, b.obligations[0].key, 'NOTICE 第 12 行已收录', 'Zen');
  const fr = freezeBatch(s, b.id, '发布冻结依据');
  assert.equal(fr.ok, true);
  const frozenObligationCount = b.frozenBasis!.obligations.length;

  // 冻结后改许可证、撤引用
  resolveLicense(s, dep.id, 'GPL-3.0');
  withdrawRef(s, dep.id, dep.refs[0].id, '误操作演示');
  assert.equal(b.frozenBasis!.obligations.length, frozenObligationCount);
  assert.deepEqual(b.frozenBasis!.sources[0].license, 'MIT');
  const report = buildReport(s, b.id);
  assert.ok(report.sections.some(x => x.name === 'chart.js' && x.basis.startsWith('MIT')));
});

test('两位负责人确认：先到形成版本，后到保留材料并列出差异', () => {
  const { s, b } = freshBatch();
  const dep = ingestSource(s, { kind: 'dependency', name: 'gpl-lib', version: '2', upstream: 'u', license: 'GPL-3.0', location: 'p' });
  createArtifact(s, b.id, 'dist', [dep.id]);
  runChecklist(s, b.id, { idemKey: 'r1' });
  for (const o of b.obligations) provideEvidence(s, b.id, o.key, `材料-${o.type}`, 'Zen');
  freezeBatch(s, b.id);

  const key = b.obligations[0].key;
  const first = confirmBatch(s, b.id, 'Alice', { [key]: 'NOTICE 行 1' }, 'c-alice');
  assert.ok(!('error' in first));
  assert.equal(first.role, 'winner');
  assert.equal(b.status, 'confirmed');

  const second = confirmBatch(s, b.id, 'Bob', { [key]: 'NOTICE 行 99（不同位置）' }, 'c-bob');
  assert.ok(!('error' in second));
  assert.equal(second.role, 'later');
  assert.ok('diff' in second && second.diff!.some(d => d.verdict === 'changed'), '后到确认列出 changed 差异');
  assert.equal(b.confirmations[0].winner, true);
  assert.equal(b.confirmations[1].winner, false);

  // 先到者重试：不新增确认记录
  const n = b.confirmations.length;
  const dup = confirmBatch(s, b.id, 'Alice', { [key]: 'NOTICE 行 1' }, 'c-alice');
  assert.ok(!('error' in dup));
  assert.equal(dup.role, 'duplicate');
  assert.equal(b.confirmations.length, n);

  // 后到者更新材料：差异重算，冻结依据不变；该键一致，其余义务仍为先到者独有
  const upd = confirmBatch(s, b.id, 'Bob', { [key]: 'NOTICE 行 1' }, 'c-bob-2');
  assert.ok(!('error' in upd));
  assert.equal(upd.role, 'later');
  assert.ok(upd.diff!.find(d => d.obKey === key)?.verdict === 'same');
  // 先到者本来就没提交其余义务材料，差异方向为“仅后到者提供”
  assert.ok(upd.diff!.filter(d => d.obKey !== key).every(d => d.verdict === 'only-later' || d.verdict === 'only-winner'));
});

test('依据后到材料另开新版本，历史版本保留', () => {
  const { s, b } = freshBatch();
  const dep = ingestSource(s, { kind: 'dependency', name: 'lib', version: '1', upstream: 'u', license: 'MIT', location: 'p' });
  createArtifact(s, b.id, 'dist', [dep.id]);
  runChecklist(s, b.id, { idemKey: 'r1' });
  provideEvidence(s, b.id, b.obligations[0].key, 'A 的材料', 'Alice');
  freezeBatch(s, b.id);
  confirmBatch(s, b.id, 'Alice', { [b.obligations[0].key]: 'A 的材料' }, 'k-a');
  confirmBatch(s, b.id, 'Bob', { [b.obligations[0].key]: 'B 的材料' }, 'k-b');

  const v2 = reopenAsNewVersion(s, b.id)!;
  assert.equal(v2.version, 2);
  assert.equal(v2.status, 'open');
  assert.equal(b.version, 1);
  assert.equal(b.status, 'confirmed');
  assert.ok(v2.obligations[0].evidence?.includes('B 的材料'), '后到者材料作为初稿带入新版本');
});

test('旧数据无指纹：迁移前被闸门拦截；迁移后按指纹归并，未处理义务不进报告', () => {
  const s = createState();
  // 直接构造两条无指纹旧记录（模拟历史数据）
  const legacy1 = ingestSource(s, { kind: 'snippet', name: 'old-util', version: '0.9', upstream: 'https://x/old-util', license: 'BSD-3-Clause', location: 'src/a.ts', legacy: true });
  const legacy2 = ingestSource(s, { kind: 'snippet', name: 'Old-Util', version: '0.9', upstream: 'https://x/old-util', license: 'BSD-3-Clause', location: 'src/b.ts', legacy: true });
  const b = createBatch(s, 'legacy-rel');
  createArtifact(s, b.id, 'dist', [legacy1.id, legacy2.id]);

  const blocked = runChecklist(s, b.id, { idemKey: 'r0' });
  assert.equal(blocked.blocked, 'legacy');

  const rep0 = buildReport(s, b.id);
  assert.ok(rep0.blockers.some(x => x.code === 'legacy'));
  assert.equal(rep0.canPublish, false);
  const issue0 = issueReport(s, b.id, 'rep-1');
  assert.ok('error' in issue0);

  const mig = migrateLegacy(s);
  assert.equal(mig.mergedGroups.length, 1, '两条旧记录按同指纹归并');
  const art = s.artifacts[b.artifactIds[0]];
  assert.equal(art.sourceIds.length, 1, '发布物中的别名已重定向');
  assert.equal(s.sources.length, 1);
  assert.ok(s.sources[0].refs.length === 2);

  const run = runChecklist(s, b.id, { idemKey: 'r1' });
  assert.equal(run.blocked, undefined);
  assert.ok(b.obligations.length >= 1);
  // 未交付材料前仍不可发布
  const rep1 = buildReport(s, b.id);
  assert.ok(rep1.blockers.some(x => x.code === 'pending'));
  assert.equal(rep1.canPublish, false);

  provideEvidence(s, b.id, b.obligations[0].key, 'LICENSES/old-util.txt', 'Zen');
  freezeBatch(s, b.id);
  confirmBatch(s, b.id, 'Alice', Object.fromEntries(b.obligations.map(o => [o.key, 'ok'])), 'k1');
  confirmBatch(s, b.id, 'Bob', Object.fromEntries(b.obligations.map(o => [o.key, 'ok'])), 'k2');
  const rep2 = buildReport(s, b.id);
  assert.equal(rep2.canPublish, true, '迁移完成且义务处理、双确认后才可发布');

  // 报告出具幂等
  const i1 = issueReport(s, b.id, 'report-key');
  assert.ok(!('error' in i1));
  const auditCount = count(s, 'report.issue');
  const i2 = issueReport(s, b.id, 'report-key');
  assert.ok(!('error' in i2));
  assert.equal(count(s, 'report.issue'), auditCount, '重试不重复出报告审计');
});

test('未知许可证：不产生义务，补全后按许可证重新计算，之前不可发布', () => {
  const { s, b } = freshBatch();
  const dep = ingestSource(s, { kind: 'dependency', name: 'mystery-pkg', version: '9', upstream: 'u', license: 'UNKNOWN', location: 'p' });
  createArtifact(s, b.id, 'dist', [dep.id]);
  runChecklist(s, b.id, { idemKey: 'r1' });
  assert.equal(b.obligations.length, 0, '未知许可证不产生合规义务');
  const rep = buildReport(s, b.id);
  assert.ok(rep.blockers.some(x => x.code === 'unknown-license'));

  resolveLicense(s, dep.id, 'Apache-2.0');
  assert.equal(b.obligations.filter(o => o.status === 'pending').length, 1);
});

test('移除发布物：只撤回受影响来源义务，其他发布物中的同指纹来源仍保留', () => {
  const { s, b } = freshBatch();
  const dep = ingestSource(s, { kind: 'dependency', name: 'shared', version: '1', upstream: 'u', license: 'MIT', location: 'p' });
  const other = ingestSource(s, { kind: 'dependency', name: 'other', version: '1', upstream: 'u2', license: 'MIT', location: 'p' });
  createArtifact(s, b.id, 'A', [dep.id, other.id]);
  createArtifact(s, b.id, 'B', [dep.id]);
  runChecklist(s, b.id, { idemKey: 'r1' });
  removeArtifact(s, b.id, b.artifactIds[0]); // 移除 A
  const shared = b.obligations.find(o => o.sourceId === dep.id)!;
  assert.notEqual(shared.status, 'withdrawn', 'shared 仍在发布物 B 中，义务保留');
  const gone = b.obligations.find(o => o.sourceId === other.id)!;
  assert.equal(gone.status, 'withdrawn', 'other 仅存在于被移除发布物，义务撤回');
});

test('Copyleft 义务推导：署名+源码要约；修改时加修改披露', () => {
  const { s, b } = freshBatch();
  const gpl = ingestSource(s, { kind: 'dependency', name: 'gpl-x', version: '1', upstream: 'u', license: 'GPL-3.0', location: 'p', modified: true });
  createArtifact(s, b.id, 'dist', [gpl.id]);
  runChecklist(s, b.id, { idemKey: 'r1' });
  const types = b.obligations.map(o => o.type).sort();
  assert.deepEqual(types, ['attribution', 'modificationDisclosure', 'sourceOffer']);
});

test('指纹稳定性：同身份不同大小写/空白得到相同指纹', () => {
  assert.equal(
    computeFingerprint({ name: 'React', version: '18.3.1', upstream: 'NPM' }),
    computeFingerprint({ name: ' react ', version: ' 18.3.1 ', upstream: ' NPM ' }),
  );
});
