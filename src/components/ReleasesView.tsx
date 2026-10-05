import { useMemo, useState } from 'react';
import { useStore, select, toggleScope, setObligationEvidence, recomputeRelease, createRelease } from '../store';
import { OBLIGATION_LABEL, Release, SourceRef } from '../types';
import { short } from '../lib/fingerprint';
import {
  CheckCircle2, CircleDashed, FileDown, FileLock2, FileWarning, Layers, Package,
  Plus, RefreshCw, Snowflake, Trash2,
} from 'lucide-react';

const KIND_ORDER = ['attribution', 'sourceOffer', 'modDisclosure'] as const;

export default function ReleasesView() {
  const { state, act } = useStore();
  const [selId, setSelId] = useState(state.releases[state.releases.length - 1]?.id ?? '');
  const release = select.releaseById(state, selId);
  const frozenOf = (rid: string) => state.batches.find((b) => (b.state === 'frozen' || b.state === 'confirmed') && b.releaseIds.includes(rid));

  const newRelease = () => act((s) => {
    const r = createRelease(s, `发布物 ${s.releases.length + 1}`, Date.now());
    return { ...s, releases: [...s.releases, r] };
  });

  return (
    <div className="view releases-view">
      <div className="view-head">
        <div><h2>发布物与义务重算</h2><p>发布物范围变化时，只重算受影响指纹的署名、源码交付与修改披露；已冻结批次中的发布物保留冻结时的原依据。</p></div>
        <button className="primary" onClick={newRelease}><Plus size={15} />新建发布物</button>
      </div>

      <div className="release-layout">
        <div className="release-list card">
          {state.releases.map((r) => {
            const fz = frozenOf(r.id);
            const pending = r.obligations.filter((o) => o.status === 'pending').length;
            return (
              <button key={r.id} className={`release-item ${r.id === selId ? 'on' : ''}`} onClick={() => setSelId(r.id)}>
                <div className="ri-top"><Package size={14} /><b>{r.label}</b></div>
                <div className="ri-meta">
                  <span>{r.refs.length} 个来源</span>
                  {fz ? <i className="tag-frozen"><Snowflake size={11} />{fz.state === 'confirmed' ? '已确认' : '已冻结'}</i>
                    : pending > 0 ? <i className="tag-pending"><FileWarning size={11} />{pending} 项义务待处理</i>
                    : r.refs.length === 0 ? <i className="tag-empty">空范围</i>
                      : <i className="tag-ready"><CheckCircle2 size={11} />可发布</i>}
                </div>
              </button>
            );
          })}
        </div>

        {release ? <ReleaseDetail key={release.id} release={release} frozen={!!frozenOf(release.id)} /> : <div className="card empty">选择或新建一个发布物</div>}
      </div>
    </div>
  );
}

function ReleaseDetail({ release, frozen }: { release: Release; frozen: boolean }) {
  const { state, act } = useStore();
  const grouped = select.grouped(state);
  const [evidence, setEvidence] = useState<Record<string, string>>({});

  const scopeFps = useMemo(() => new Set(release.scopeFingerprints), [release.scopeFingerprints]);
  const pending = release.obligations.filter((o) => o.status === 'pending');
  const ready = release.refs.length > 0 && pending.length === 0;

  const exportReport = () => {
    const lines = [
      `# 可发布许可报告 · ${release.label}`,
      `> 生成时间 ${new Date().toLocaleString()} · 依据：发布物当前指纹范围`,
      '',
      '## 范围来源',
      ...release.refs.map((r) => `- ${r.name}${r.version ? '@' + r.version : ''}（${r.license}）指纹 ${short(r.fingerprint)}`),
      '',
      '## 许可义务履行',
      ...KIND_ORDER.flatMap((k) =>
        release.obligations.filter((o) => o.kind === k).map((o) =>
          `- [${o.status === 'satisfied' ? 'x' : ' '}] **${OBLIGATION_LABEL[o.kind]}** · ${o.sourceName}（${o.license}）— ${o.detail}${o.evidence ? `  证据：${o.evidence}` : ''}`)),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${release.label.replace(/[\\s/（）()]/g, '_')}-notice.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="release-detail">
      {frozen && (
        <div className="frozen-banner">
          <FileLock2 size={16} />
          <div><b>该发布物已被冻结批次收录，保留原依据</b>
            <p>范围、义务状态与证据均以冻结快照为准；撤下片段等后续变化只影响在制发布物，不会改写这里的署名与源码链接。</p>
          </div>
        </div>
      )}

      <div className="card scope-card">
        <div className="card-head">
          <div><h3><Layers size={14} />发布物范围（按指纹勾选）</h3><p>同一指纹的多条登记已归并；未迁移旧数据不可勾选。</p></div>
          {!frozen && <button className="ghost" onClick={() => act((s) => recomputeRelease(s, release.id, Date.now()))}><RefreshCw size={13} />重算</button>}
        </div>
        <div className="scope-grid">
          {[...grouped.entries()].map(([fp, recs]) => {
            const rec = recs[0];
            const checked = scopeFps.has(fp);
            return (
              <label key={fp} className={`scope-item ${checked ? 'in' : ''}`}>
                <input type="checkbox" checked={checked} disabled={frozen}
                  onChange={() => act((s) => toggleScope(s, release.id, fp, Date.now()))} />
                <span className="si-name">{rec.name}{rec.version && <em>{rec.version}</em>}</span>
                <i className="license-tag small">{rec.license}</i>
                {recs.length > 1 && <i className="dup">×{recs.length}</i>}
                <span className="mono fp">{short(fp, 8)}</span>
              </label>
            );
          })}
        </div>
        {(release.changes.added.length > 0 || release.changes.removed.length > 0) && (
          <div className="scope-changes">
            <b>范围变化（增量重算依据）</b>
            <div className="change-row">
              {release.changes.removed.map((r) => (
                <span key={r.fingerprint} className="change-chip removed" title={`指纹 ${r.fingerprint}`}>
                  <Trash2 size={11} />撤下：{r.name} <em>其署名/源码链接义务已从当前发布物移除</em>
                </span>
              ))}
              {release.changes.added.map((fp) => (
                <span key={fp} className="change-chip added">＋ 纳入：{release.refs.find((r) => r.fingerprint === fp)?.name ?? short(fp)}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="card oblig-card">
        <div className="card-head">
          <div><h3>许可义务（键 = 指纹 × 类型，重算时保留履行状态）</h3><p>{release.obligations.length} 项义务，{pending.length} 项未处理。</p></div>
        </div>
        {release.obligations.length === 0 && <div className="empty-pad">范围为空时不产生义务。</div>}
        {KIND_ORDER.map((kind) => {
          const items = release.obligations.filter((o) => o.kind === kind);
          if (!items.length) return null;
          return (
            <div key={kind} className="oblig-group">
              <h4>{OBLIGATION_LABEL[kind]}<i>{items.length}</i></h4>
              {items.map((o) => (
                <div key={o.key} className={`oblig-row ${o.status}`}>
                  <div className="oblig-main">
                    {o.status === 'satisfied' ? <CheckCircle2 size={16} className="ok-ic" /> : <CircleDashed size={16} className="pend-ic" />}
                    <div>
                      <b>{o.sourceName}</b> <i className="license-tag small">{o.license}</i>
                      <p>{o.detail}</p>
                      <div className="oblig-basis mono">义务键 {short(o.key.split(':')[0], 12)} · 依据指纹 {short(o.basisFingerprint, 12)}</div>
                      {o.evidence && <div className="evidence">证据：{o.evidence}</div>}
                    </div>
                  </div>
                  {!frozen && (
                    o.status === 'pending' ? (
                      <div className="oblig-act">
                        <input placeholder="填写履行证据（NOTICE 章节 / 源码包 / 披露位置）"
                          value={evidence[o.key] ?? ''} onChange={(e) => setEvidence((v) => ({ ...v, [o.key]: e.target.value }))} />
                        <button className="primary sm" disabled={!(evidence[o.key] ?? '').trim()}
                          onClick={() => act((s) => setObligationEvidence(s, release.id, o.key, evidence[o.key].trim(), Date.now()))}>
                          标记已履行
                        </button>
                      </div>
                    ) : <span className="done-badge"><CheckCircle2 size={12} />已履行</span>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <div className={`card report-card ${ready ? '' : 'blocked'}`}>
        <div className="card-head">
          <div><h3>可发布报告</h3>
            <p>{ready
              ? '全部义务已处理，报告可随发布物出具。'
              : `未处理义务不进可发布报告：${pending.length} 项待履行${release.refs.length === 0 ? '，且发布物范围为空' : ''}。`}</p>
          </div>
          <button className="outline" disabled={!ready} onClick={exportReport}><FileDown size={14} />导出声明报告</button>
        </div>
        <div className="report-preview">
          <b>{release.label}</b>
          <div className="rp-refs">{release.refs.map((r: SourceRef) => (
            <span key={r.fingerprint} className="rp-ref">{r.name} · {r.license}</span>
          ))}</div>
          {!ready && <div className="rp-blocked"><FileWarning size={13} />{pending.length} 项义务未处理，报告已阻断</div>}
        </div>
      </div>
    </div>
  );
}
