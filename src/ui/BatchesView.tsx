import { useState } from 'react';
import { Archive, Boxes, GitBranch, Plus, Snowflake, Trash2 } from 'lucide-react';
import type { Store } from '../core/store';
import { attachSources, createArtifact, createBatch, removeArtifact } from '../core/engine.js';
import { Badge, Card, Field, Modal } from './widgets.js';
import type { Batch } from '../core/types.js';

const statusMeta = (b: Batch) =>
  b.status === 'confirmed' ? { label: `已确认 · v${b.version}`, tone: 'teal' as const }
    : b.status === 'frozen' ? { label: `已冻结 · v${b.version}`, tone: 'blue' as const }
      : { label: `开放中 · v${b.version}`, tone: 'orange' as const };

export function BatchesView({ store, selectedId, onSelect }: { store: Store; selectedId: string; onSelect: (id: string) => void }) {
  const { state, commit } = store;
  const [newBatch, setNewBatch] = useState(false);
  const [batchName, setBatchName] = useState('');
  const [newArtFor, setNewArtFor] = useState<string | null>(null);
  const [artName, setArtName] = useState('');
  const [pickFor, setPickFor] = useState<{ batchId: string; artifactId: string } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  return (
    <>
      <div className="view-head">
        <div>
          <h2>发布批次与发布物</h2>
          <p>批次是义务与报告的边界；冻结后依据固定，范围再变化只影响新版本。</p>
        </div>
        <button className="btn primary" onClick={() => setNewBatch(true)}><Plus size={14} />新建批次</button>
      </div>

      <div className="batch-grid">
        {state.batches.map(b => {
          const meta = statusMeta(b);
          const total = b.artifactIds.length;
          const done = b.processedArtifacts.length;
          return (
            <Card key={b.id} className={b.id === selectedId ? 'batch-card selected' : 'batch-card'}>
              <button className="batch-head" onClick={() => onSelect(b.id)}>
                <span className="batch-icon"><Boxes size={16} /></span>
                <span>
                  <b>{b.name}</b>
                  <small>{b.id} · 创建于 {new Date(b.createdAt).toLocaleDateString()}</small>
                </span>
                <Badge tone={meta.tone}>{meta.label}</Badge>
              </button>

              <div className="progress">
                <div style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
              </div>
              <small className="progress-label">
                续作检查点：{done}/{total} 个发布物已完整处理
                {b.interruptedAt && <Badge tone="red">写入中断，待续跑</Badge>}
              </small>

              <div className="art-list">
                {b.artifactIds.map(aid => {
                  const art = state.artifacts[aid];
                  if (!art) return null;
                  const complete = b.processedArtifacts.includes(aid);
                  return (
                    <div key={aid} className={`art ${complete ? 'done' : ''}`}>
                      <Archive size={13} />
                      <span>{art.name}</span>
                      <small>{art.sourceIds.length} 个指纹来源</small>
                      {complete ? <Badge tone="teal">已核对</Badge> : <Badge tone="gray">待处理</Badge>}
                      {b.status === 'open' && (
                        <>
                          <button className="icon-btn" title="纳入更多来源" onClick={() => { setPickFor({ batchId: b.id, artifactId: aid }); setPicked(new Set(art.sourceIds)); }}><Plus size={12} /></button>
                          <button className="icon-btn" title="移除发布物（只重算受影响署名）" onClick={() => commit(d => removeArtifact(d, b.id, aid))}><Trash2 size={12} /></button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="batch-foot">
                {b.frozenBasis && <span className="frozen-note"><Snowflake size={12} /> 依据冻结于 {new Date(b.frozenBasis.frozenAt).toLocaleString()}</span>}
                {b.confirmations.length > 0 && <span className="confirm-note"><GitBranch size={12} /> {b.confirmations.length} 份确认（{b.confirmations.map(c => c.owner).join(' / ')}）</span>}
                {b.status === 'open' && (
                  <div className="row-gap">
                    <button className="btn ghost sm" onClick={() => { setNewArtFor(b.id); setArtName(''); }}><Plus size={12} />发布物</button>
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {newBatch && (
        <Modal title="新建发布批次" onClose={() => setNewBatch(false)} width={420}>
          <Field label="批次名称"><input className="ui-input" autoFocus value={batchName} onChange={e => setBatchName(e.target.value)} placeholder="如 Aurora 2026.11" /></Field>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setNewBatch(false)}>取消</button>
            <button className="btn primary" disabled={!batchName.trim()} onClick={() => {
              commit(d => { const b = createBatch(d, batchName.trim()); onSelect(b.id); });
              setBatchName(''); setNewBatch(false);
            }}>创建</button>
          </div>
        </Modal>
      )}

      {newArtFor && (
        <Modal title="新增发布物" onClose={() => setNewArtFor(null)} width={420}>
          <Field label="发布物名称"><input className="ui-input" autoFocus value={artName} onChange={e => setArtName(e.target.value)} placeholder="如 mobile-bundle.zip" /></Field>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setNewArtFor(null)}>取消</button>
            <button className="btn primary" disabled={!artName.trim()} onClick={() => {
              commit(d => createArtifact(d, newArtFor, artName.trim()));
              setNewArtFor(null);
            }}>加入批次</button>
          </div>
        </Modal>
      )}

      {pickFor && (
        <Modal title="选择发布物包含的指纹来源" onClose={() => setPickFor(null)} width={560}>
          <div className="pick-list">
            {state.sources.map(s => {
              const disabled = !s.fingerprint;
              return (
                <label key={s.id} className={`pick ${disabled ? 'disabled' : ''}`}>
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={picked.has(s.id)}
                    onChange={e => {
                      const next = new Set(picked);
                      e.target.checked ? next.add(s.id) : next.delete(s.id);
                      setPicked(next);
                    }}
                  />
                  <b>{s.name}</b>
                  <code className="fp">{s.fingerprint || '无指纹（先迁移）'}</code>
                  <Badge tone={s.license === 'UNKNOWN' ? 'red' : 'gray'}>{s.license}</Badge>
                </label>
              );
            })}
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setPickFor(null)}>取消</button>
            <button className="btn primary" onClick={() => {
              commit(d => attachSources(d, pickFor.batchId, pickFor.artifactId, [...picked]));
              setPickFor(null);
            }}>保存范围</button>
          </div>
        </Modal>
      )}
    </>
  );
}
