import { useState } from 'react';
import { useStore, select, createBatch, freezeBatch, confirmBatch, buildMaterialFromBatch, createWriteJob } from '../store';
import { OBLIGATION_LABEL } from '../types';
import { short } from '../lib/fingerprint';
import {
  Check, Clock3, GitPullRequestArrow, Play, ShieldCheck, Snowflake, Users, X,
} from 'lucide-react';

export default function BatchesView() {
  const { state, act } = useStore();
  const [creating, setCreating] = useState(false);
  const [selBatch, setSelBatch] = useState(state.batches[state.batches.length - 1]?.id ?? '');
  const batch = select.batchById(state, selBatch);

  const readyReleases = state.releases.filter((r) =>
    r.refs.length > 0 && r.obligations.every((o) => o.status === 'satisfied')
    && !state.batches.some((b) => b.releaseIds.includes(r.id)));

  return (
    <div className="view">
      <div className="view-head">
        <div><h2>发布批次</h2><p>可发布的发布物组成批次；冻结后锁定署名 / 源码交付 / 修改披露的原依据，两位负责人确认时先到者形成版本。</p></div>
        <button className="primary" onClick={() => setCreating(true)} disabled={readyReleases.length === 0}><GitPullRequestArrow size={15} />组建批次</button>
      </div>

      <div className="batch-layout">
        <div className="batch-list card">
          {state.batches.map((b) => (
            <button key={b.id} className={`batch-item ${b.id === selBatch ? 'on' : ''}`} onClick={() => setSelBatch(b.id)}>
              <div className="bi-top"><b>{b.name}</b></div>
              <div className="bi-meta">
                <span>{b.releaseIds.length} 个发布物</span>
                {b.state === 'open' && <i className="st open"><Clock3 size={11} />待冻结</i>}
                {b.state === 'frozen' && <i className="st frozen"><Snowflake size={11} />已冻结待确认</i>}
                {b.state === 'confirmed' && <i className="st confirmed"><ShieldCheck size={11} />已确认</i>}
              </div>
              {b.confirmations.length > 0 && <div className="bi-owners"><Users size={11} />{b.confirmations.map((c) => <span key={c.id} className={`owner ${c.role}`}>{c.owner.split('（')[0]}·{c.role === 'winner' ? '先到' : '后到'}</span>)}</div>}
            </button>
          ))}
        </div>

        {batch ? (
          <div className="batch-detail card">
            <div className="bd-head">
              <div>
                <h3>{batch.name}</h3>
                <div className="bd-state">
                  {batch.state === 'open' && <span className="st open"><Clock3 size={12} />开放中</span>}
                  {batch.state === 'frozen' && <span className="st frozen"><Snowflake size={12} />已冻结，等待两位发布负责人确认</span>}
                  {batch.state === 'confirmed' && <span className="st confirmed"><ShieldCheck size={12} />已形成发布版本</span>}
                </div>
              </div>
              <div className="bd-actions">
                {batch.state === 'open' && <button className="primary" onClick={() => act((s) => freezeBatch(s, batch.id, Date.now()))}><Snowflake size={14} />冻结依据</button>}
                {batch.state === 'confirmed' && !state.jobs.some((j) => j.batchId === batch.id) &&
                  <button className="primary" onClick={() => act((s) => createWriteJob(s, batch.id, Date.now()) as any)}><Play size={14} />创建写入作业</button>}
                {batch.state === 'confirmed' && state.jobs.some((j) => j.batchId === batch.id) &&
                  <span className="done-badge"><Check size={12} />写入作业已创建（见「写入续作」）</span>}
              </div>
            </div>

            {batch.frozen && (
              <div className="freeze-box">
                <div className="fz-line"><Snowflake size={13} />冻结时间 {new Date(batch.frozen.frozenAt).toLocaleString()}</div>
                <div className="fz-line mono">报告依据摘要 {batch.frozen.reportDigest}</div>
                <p>此后即使撤下片段、修改来源或重算在制发布物，本批次报告中的署名与源码链接仍保持以下内容不变。</p>
                <div className="fz-releases">
                  {batch.frozen.releases.map((r) => (
                    <details key={r.releaseId} className="fz-release">
                      <summary>{r.label} · {r.refs.length} 来源 · {r.obligations.length} 义务</summary>
                      <ul>
                        {r.obligations.map((o) => (
                          <li key={o.key}><b>{OBLIGATION_LABEL[o.kind]}</b> · {o.sourceName}（{o.license}）<i className={o.status}>{o.status === 'satisfied' ? '已履行' : '未履行'}</i><span className="mono dim">{short(o.basisFingerprint, 10)}</span></li>
                        ))}
                      </ul>
                    </details>
                  ))}
                </div>
              </div>
            )}

            {batch.state === 'frozen' && (
              <div className="confirm-box">
                <h4><Users size={14} />两位发布负责人确认（模拟）</h4>
                <p>两人可先后提交各自准备的材料；先到者形成版本，后到者的材料原样保留并列出与先到版本的差异。</p>
                <div className="confirm-btns">
                  <button className="primary" onClick={() => {
                    const m = buildMaterialFromBatch(state, batch, 'Zen Li（发布负责人 A）', '按最终构建产物核对，义务齐备');
                    act((s) => confirmBatch(s, batch.id, m, Date.now()));
                    setSelBatch(batch.id);
                  }}><Check size={14} />负责人 A 提交确认（材料与冻结依据一致）</button>
                  <button className="outline" onClick={() => {
                    // B 抢先，但材料漏处理了发布物中第一项义务 → 由其先到形成版本
                    const m = buildMaterialFromBatch(state, batch, 'Mara Yu（发布负责人 B）', '我这边构建树少打了一个源码包', batch.releaseIds[0]);
                    act((s) => confirmBatch(s, batch.id, m, batch.frozen!.frozenAt - 60_000));
                    setSelBatch(batch.id);
                  }}><Check size={14} />负责人 B 抢先确认（材料有差异）</button>
                </div>
              </div>
            )}

            {batch.state === 'confirmed' && !batch.confirmations.some((c) => c.role === 'late') && (
              <div className="confirm-box late">
                <h4><Users size={14} />后到确认</h4>
                <p>版本已由 {batch.confirmations[0].owner.split('（')[0]} 先到形成。另一位负责人仍可补交材料：材料会原样保留，与先到版本的差异逐条列出，但不会覆盖版本。</p>
                <div className="confirm-btns">
                  <button className="outline" onClick={() => {
                    const other = batch.confirmations[0].owner.includes('Zen Li') ? 'Mara Yu（发布负责人 B）' : 'Zen Li（发布负责人 A）';
                    const m = buildMaterialFromBatch(state, batch, other, '我这边构建树少打了一个源码包', batch.releaseIds[0]);
                    act((s) => confirmBatch(s, batch.id, m, Date.now()));
                    setSelBatch(batch.id);
                  }}><GitPullRequestArrow size={14} />另一位负责人补交确认（材料漏一项义务）</button>
                </div>
              </div>
            )}

            {batch.confirmations.length > 0 && (
              <div className="attempts">
                <h4>确认记录</h4>
                {batch.confirmations.map((c) => (
                  <div key={c.id} className={`attempt ${c.role}`}>
                    <div className="att-head">
                      <i className={`role-badge ${c.role}`}>{c.role === 'winner' ? '先到 · 形成版本' : '后到 · 保留材料'}</i>
                      <b>{c.owner}</b><span className="dim">{new Date(c.receivedAt).toLocaleTimeString()}</span>
                    </div>
                    <p className="att-note">“{c.note}”</p>
                    <div className="mono dim att-digest">材料摘要 {short(c.materialDigest, 13)}</div>
                    {c.diff && (
                      <div className="diff-box">
                        <b>与先到版本差异（{c.diff.length} 项，不覆盖已形成版本）</b>
                        {c.diff.map((d, i) => (
                          <div key={i} className="diff-row">
                            <i className="diff-type">{d.type === 'digest' ? '摘要' : d.type === 'obligation' ? '义务' : '发布物'}</i>
                            <span className="diff-subj">{d.subject}</span>
                            <span className="diff-vals"><em>先到：{d.winner}</em> → <em>后到：{d.late}</em></span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : <div className="card empty">尚无批次</div>}
      </div>

      {creating && <CreateBatchModal onClose={() => setCreating(false)}
        onCreate={(name, ids) => {
          const r = createBatch(state, name, ids, Date.now());
          if (typeof r === 'string') { alert(r); return; }
          act(() => r);
          setSelBatch(r.batches[r.batches.length - 1].id);
          setCreating(false);
        }}
        ready={readyReleases} />}
    </div>
  );
}

function CreateBatchModal({ onClose, onCreate, ready }: {
  onClose: () => void;
  onCreate: (name: string, ids: string[]) => void;
  ready: ReturnType<typeof select.releaseById>[] | any[];
}) {
  const [name, setName] = useState('Aurora Web 发布批次');
  const [ids, setIds] = useState<string[]>(ready.map((r) => r.id));
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>组建发布批次</h2><button onClick={onClose}><X size={16} /></button></div>
        <label className="block">批次名称<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="pick-list">
          {ready.map((r) => (
            <label key={r.id} className="pick-item">
              <input type="checkbox" checked={ids.includes(r.id)}
                onChange={() => setIds((x) => x.includes(r.id) ? x.filter((i) => i !== r.id) : [...x, r.id])} />
              <b>{r.label}</b><i>{r.refs.length} 来源 · {r.obligations.length} 义务均已处理</i>
            </label>
          ))}
          {ready.length === 0 && <p className="dim">没有可进入批次的发布物（存在未处理义务）。</p>}
        </div>
        <button className="primary full" disabled={!name.trim() || ids.length === 0} onClick={() => onCreate(name.trim(), ids)}>组建批次</button>
      </div>
    </div>
  );
}
