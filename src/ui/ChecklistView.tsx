import { useState } from 'react';
import {
  AlertTriangle, ArrowRight, Ban, CheckCircle2, FileSignature, GitBranch,
  Play, ShieldCheck, Snowflake, Zap,
} from 'lucide-react';
import type { Store } from '../core/store';
import type { Batch } from '../core/types.js';
import {
  confirmBatch, findSource, freezeBatch, provideEvidence, reopenAsNewVersion, runChecklist,
} from '../core/engine.js';
import { OBLIGATION_LABEL } from '../core/fingerprint.js';
import { Badge, Card } from './widgets.js';

const TYPE_TONE = { attribution: 'blue', sourceOffer: 'violet', modificationDisclosure: 'orange' } as const;

export function ChecklistView({
  store, batch, owner, onNewBatch,
}: { store: Store; batch: Batch | undefined; owner: string; onNewBatch: (id: string) => void }) {
  const { state, commit } = store;
  const [failAfter, setFailAfter] = useState(1);
  const [simulate, setSimulate] = useState(false);
  const [lastIdem, setLastIdem] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  if (!batch) return <Card><p className="muted-p">请先在“批次”页选择一个发布批次。</p></Card>;

  const total = batch.artifactIds.length;
  const done = batch.processedArtifacts.length;
  const pending = batch.obligations.filter(o => o.status === 'pending');
  const withdrawn = batch.obligations.filter(o => o.status === 'withdrawn');
  const satisfied = batch.obligations.filter(o => o.status === 'satisfied');
  const winner = batch.confirmations.find(c => c.winner);
  const later = batch.confirmations.find(c => !c.winner);

  const legacyInScope = state.sources.some(s =>
    !s.fingerprint && batch.artifactIds.some(a => state.artifacts[a]?.sourceIds.includes(s.id)));

  const run = (retry = false) => {
    const idem = retry && lastIdem[batch.id] ? lastIdem[batch.id] : `run-${batch.id}-${Date.now()}`;
    setLastIdem(m => ({ ...m, [batch.id]: idem }));
    commit(d => {
      const r = runChecklist(d, batch.id, { idemKey: idem, failAfter: simulate && !retry ? failAfter : undefined });
      if (r.blocked === 'legacy') setNotice('闸门拦截：范围内存在无指纹旧数据，请先到“来源”页完成迁移。');
      else if (r.blocked === 'frozen') setNotice('批次已冻结，清单不再变更；如需调整请另开新版本。');
      else if (r.interrupted) setNotice(`写入中断：检查点停在第 ${d.batches.find(b => b.id === batch.id)!.processedArtifacts.length} 个完整发布物。用“同请求重试”可从该处继续。`);
      else if (r.processedThisRun.length === 0) setNotice(retry ? '重试落在最后一个完整发布物之后：没有重复生成义务或审计。' : '清单已是最新，没有新工作。');
      else setNotice(`本次处理 ${r.processedThisRun.length} 个发布物；受影响指纹 ${new Set(r.changedFingerprints).size} 个，其余署名/源码义务未重算。`);
    });
  };

  const freeze = () => {
    commit(d => {
      const r = freezeBatch(d, batch.id, '发布前评审冻结');
      if (!r.ok) setNotice(`无法冻结：${r.reason}`);
      else setNotice('批次已冻结，依据（来源快照、义务与证据）固定，之后撤下片段或改许可证都不影响本批次。');
    });
  };

  const confirm = () => {
    commit(d => {
      const materials = Object.fromEntries(
        d.batches.find(b => b.id === batch.id)!.obligations
          .filter(o => o.status !== 'withdrawn' && o.evidence)
          .map(o => [o.key, o.evidence!]),
      );
      const r = confirmBatch(d, batch.id, owner, materials, `confirm-${batch.id}-${owner}-${Date.now()}`);
      if ('error' in r) { setNotice(r.error); return; }
      setNotice(
        r.role === 'winner' ? `${owner} 的确认先到，批次形成发布版本。`
          : r.role === 'duplicate' ? `${owner} 的确认已存在，重试未产生重复记录。`
            : `${owner} 的确认后到：材料已保留，与先到版本的差异见下方清单，发布仍以先到版本为准。`,
      );
    });
  };

  return (
    <>
      <div className="view-head">
        <div>
          <h2>续作清单 · {batch.name} <Badge tone="gray">v{batch.version}</Badge></h2>
          <p>义务按 <code>批次:来源指纹:类型</code> 稳定编号；发布物范围变化时只重算受影响指纹。中断后从最后一个完整发布物继续。</p>
        </div>
        <div className="row-gap">
          {batch.status === 'open' && (
            <>
              <label className="check sm"><input type="checkbox" checked={simulate} onChange={e => setSimulate(e.target.checked)} /> 模拟写入中断</label>
              {simulate && (
                <input className="ui-input xs" type="number" min={1} value={failAfter} onChange={e => setFailAfter(Math.max(1, +e.target.value || 1))} title="处理完 N 个新发布物后中断" />
              )}
              <button className="btn outline" onClick={() => run(false)}><Play size={14} />{done > 0 && !batch.interruptedAt ? '推进清单' : '运行清单'}</button>
              <button className="btn primary" disabled={!batch.interruptedAt} onClick={() => run(true)}><Zap size={14} />同请求重试 / 续跑</button>
              <button className="btn outline" onClick={freeze}><Snowflake size={14} />冻结批次</button>
            </>
          )}
          {batch.status === 'frozen' && <button className="btn primary" onClick={confirm}><FileSignature size={14} />以 {owner} 身份确认</button>}
          {batch.status === 'confirmed' && later && (
            <button className="btn outline" onClick={() => commit(d => { const v = reopenAsNewVersion(d, batch.id); if (v) { onNewBatch(v.id); setNotice(`已另开 v${v.version}，${later.owner} 保留的材料作为初稿带入。`); } })}>
              <GitBranch size={14} />依据后到材料另开新版本
            </button>
          )}
        </div>
      </div>

      {notice && <Card className="notice"><span onClick={() => setNotice(null)}>×</span><p>{notice}</p></Card>}
      {legacyInScope && <Card className="notice warn"><Ban size={15} /><p>闸门：范围内有无指纹旧数据。迁移完成前清单不会生成义务，未处理义务不进可发布报告。</p></Card>}

      <div className="stat-row">
        <Card className="stat"><span>发布物检查点</span><b>{done}/{total}</b></Card>
        <Card className="stat"><span>待交付义务</span><b className="red">{pending.length}</b></Card>
        <Card className="stat"><span>已交付</span><b className="teal">{satisfied.length}</b></Card>
        <Card className="stat"><span>已撤回（范围外留痕）</span><b>{withdrawn.length}</b></Card>
      </div>

      {batch.status !== 'open' && (
        <Card className="frozen-panel">
          <div><ShieldCheck size={16} /><b>{batch.status === 'frozen' ? '批次已冻结：依据固定' : '批次已确认形成版本'}</b>
            <p>快照含 {batch.frozenBasis?.sources.length} 个来源、{batch.frozenBasis?.obligations.length} 项义务，冻结于 {batch.frozenBasis && new Date(batch.frozenBasis.frozenAt).toLocaleString()}。此后撤下片段或改许可证不改变本版本报告。</p>
          </div>
        </Card>
      )}

      <Card className="ob-table">
        <div className="ob title-row"><span>义务</span><span>来源指纹</span><span>依据与材料</span><span>状态 / 证据</span></div>
        {batch.obligations.map(o => {
          const src = findSource(state, o.sourceId) ?? batch.frozenBasis?.sources.find(x => x.id === o.sourceId);
          const isWithdrawn = o.status === 'withdrawn';
          return (
            <div className={`ob ${isWithdrawn ? 'withdrawn' : ''}`} key={o.key}>
              <span><Badge tone={TYPE_TONE[o.type]}>{OBLIGATION_LABEL[o.type]}</Badge><b>{src?.name ?? o.sourceId}</b><small className="ob-key">{o.key}</small></span>
              <span><code className="fp">{o.fingerprint}</code></span>
              <span><p>{o.material}</p><small>{o.basis}</small></span>
              <span className="ev">
                {isWithdrawn
                  ? <Badge tone="gray">已随撤下撤回</Badge>
                  : o.status === 'satisfied'
                    ? <><CheckCircle2 size={14} className="teal-ic" /><small title={o.evidence}>{o.evidence}{o.owner ? `（${o.owner}）` : ''}</small></>
                    : batch.status === 'open'
                      ? <div className="ev-input">
                        <input className="ui-input sm" placeholder="填写交付材料 / 位置" onKeyDown={e => {
                          if (e.key === 'Enter' && (e.target as HTMLInputElement).value.trim()) {
                            const v = (e.target as HTMLInputElement).value.trim();
                            commit(d => provideEvidence(d, batch.id, o.key, v, owner));
                          }
                        }} />
                        <small>回车交付（{owner}）</small>
                      </div>
                      : <AlertTriangle size={14} className="red-ic" />}
              </span>
            </div>
          );
        })}
        {batch.obligations.length === 0 && <p className="muted-p pad">运行清单后，义务会按指纹在这里出现。</p>}
      </Card>

      {(winner || later) && (
        <Card className="confirm-panel">
          <h3>双负责人确认</h3>
          {winner && (
            <div className="confirm winner">
              <Badge tone="teal">先到 · 形成版本</Badge>
              <b>{winner.owner}</b><small>{new Date(winner.at).toLocaleString()}</small>
              <small>提交 {Object.keys(winner.materials).length} 份材料</small>
            </div>
          )}
          {later && (
            <div className="confirm later">
              <div><Badge tone="orange">后到 · 材料保留</Badge><b>{later.owner}</b><small>{new Date(later.at).toLocaleString()}</small></div>
              <ul className="diff">
                {(later.diff ?? []).map(d => (
                  <li key={d.obKey} className={`v-${d.verdict}`}>
                    <Badge tone={d.verdict === 'same' ? 'teal' : d.verdict === 'changed' ? 'red' : 'orange'}>
                      {d.verdict === 'same' ? '一致' : d.verdict === 'changed' ? '材料不同' : d.verdict === 'only-winner' ? '仅先到者提交' : '仅后到者提交'}
                    </Badge>
                    <span>{d.label}</span>
                    {d.verdict === 'changed' && <span className="cmp"><s>{d.winner}</s> <ArrowRight size={11} /> {d.later}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
