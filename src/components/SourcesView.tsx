import { useState } from 'react';
import { useStore } from '../store';
import { short } from '../lib/fingerprint';
import { FileCode2, GitMerge, Layers, Plus, X } from 'lucide-react';
import { SourceRecord } from '../types';

const LICENSES = ['MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Apache-2.0', 'GPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'MPL-2.0', 'EPL-2.0'];

export default function SourcesView() {
  const { state, addSource } = useStore();
  const [showAdd, setShowAdd] = useState(false);
  const [open, setOpen] = useState<string | null>(state.sources[0]?.fingerprint ?? null);

  // 按指纹归并展示：同一指纹只占一行，标注归并了几条登记
  const groups = new Map<string, SourceRecord[]>();
  for (const s of state.sources) {
    const key = s.fingerprint ?? `legacy:${s.id}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const ordered = [...groups.values()].sort((a, b) => Number(!!a[0].fingerprint) - Number(!!b[0].fingerprint));

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h2>来源指纹库</h2>
          <p>依赖与第三方代码片段统一登记；同一指纹归并为一个来源，全发布物只产生一份署名 / 源码交付 / 修改披露义务。</p>
        </div>
        <button className="primary" onClick={() => setShowAdd(true)}><Plus size={15} />登记来源</button>
      </div>

      <div className="fp-table card">
        <div className="fp-tr fp-th">
          <span>来源（已按指纹归并）</span><span>指纹 SHA-256</span><span>许可</span><span>义务面</span><span>登记数</span>
        </div>
        {ordered.map((recs) => {
          const rec = recs[0];
          const legacy = !rec.fingerprint;
          const kinds = new Set<string>();
          if (!legacy) {
            // 义务面与 engine 规则保持一致的展示推导
            kinds.add('署名');
            if (['GPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'MPL-2.0', 'EPL-2.0', 'CDDL-1.0'].includes(rec.license)) kinds.add('源码交付');
            if (rec.modified && ['Apache-2.0', 'GPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'MPL-2.0', 'EPL-2.0'].includes(rec.license)) kinds.add('修改披露');
          }
          const expanded = open === (rec.fingerprint ?? `legacy:${rec.id}`);
          return (
            <div key={rec.fingerprint ?? rec.id} className={`fp-group ${legacy ? 'legacy' : ''}`}>
              <button className="fp-tr" onClick={() => setOpen(expanded ? null : (rec.fingerprint ?? `legacy:${rec.id}`))}>
                <span className="src-cell">
                  <i className={`kind-badge ${rec.kind}`}>{rec.kind === 'dependency' ? <Layers size={12} /> : <FileCode2 size={12} />}{rec.kind === 'dependency' ? '依赖' : '片段'}</i>
                  <b>{rec.name}</b>{rec.version && <em>{rec.version}</em>}
                  {rec.modified && <i className="mod-flag">已修改</i>}
                  {legacy && <i className="legacy-flag">待迁移</i>}
                </span>
                <span className="mono">{legacy ? '— 无指纹 —' : short(rec.fingerprint, 16)}</span>
                <span><i className="license-tag">{rec.license}</i></span>
                <span className="kinds">{legacy ? <i className="dim">迁移后推导</i> : [...kinds].map((k) => <i key={k} className="oblig-chip">{k}</i>)}</span>
                <span className="merge-cell">
                  {recs.length > 1 && <span className="merge-badge"><GitMerge size={12} />×{recs.length} 归并</span>}
                  {recs.length === 1 && <i className="dim">1</i>}
                </span>
              </button>
              {expanded && (
                <div className="fp-detail">
                  {recs.length > 1 && (
                    <div className="merge-note"><GitMerge size={13} /> 以下 {recs.length} 条登记指纹相同，已归并，义务只生成一份：
                      <ul>{recs.map((r) => <li key={r.id}>{r.name}{r.copyrightHolder ? ` · ${r.copyrightHolder}` : ''} <span className="mono dim">id {short(r.id, 12)}</span>{r.id === rec.id && '（代表记录）'}</li>)}</ul>
                    </div>
                  )}
                  <div className="fp-detail-grid">
                    <div><label>版权方</label><b>{rec.copyrightHolder || '—'}</b></div>
                    <div><label>源码链接</label>{rec.originUrl ? <a href={rec.originUrl} target="_blank" rel="noreferrer" className="src-link">{rec.originUrl}</a> : <b>—</b>}</div>
                    <div><label>修改</label><b>{rec.modified ? rec.modificationNote || '已修改（未填写说明）' : '未修改'}</b></div>
                  </div>
                  {rec.kind === 'snippet' && rec.code && <pre className="code-preview">{rec.code}</pre>}
                  {legacy && <div className="legacy-hint">旧系统遗留记录：完成指纹迁移后才能加入发布物，其义务当前不计入任何可发布报告。</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {showAdd && <AddSourceModal onClose={() => setShowAdd(false)} onAdd={addSource} />}
    </div>
  );
}

function AddSourceModal({ onClose, onAdd }: {
  onClose: () => void;
  onAdd: (x: {
    kind: 'dependency' | 'snippet'; name: string; version?: string; license: string;
    originUrl?: string; copyrightHolder?: string; code?: string; modified: boolean; modificationNote?: string;
  }) => Promise<void>;
}) {
  const [kind, setKind] = useState<'dependency' | 'snippet'>('dependency');
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [license, setLicense] = useState('MIT');
  const [originUrl, setOriginUrl] = useState('');
  const [holder, setHolder] = useState('');
  const [code, setCode] = useState('');
  const [modified, setModified] = useState(false);
  const [note, setNote] = useState('');

  const submit = async () => {
    if (!name.trim()) return;
    if (kind === 'snippet' && !code.trim()) return;
    await onAdd({
      kind, name: name.trim(), version: version.trim() || undefined, license,
      originUrl: originUrl.trim() || undefined, copyrightHolder: holder.trim() || undefined,
      code: kind === 'snippet' ? code : undefined, modified,
      modificationNote: modified ? note : undefined,
    });
    onClose();
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>登记来源</h2><button onClick={onClose}><X size={16} /></button></div>
        <div className="seg">
          <button className={kind === 'dependency' ? 'on' : ''} onClick={() => setKind('dependency')}><Layers size={14} />依赖</button>
          <button className={kind === 'snippet' ? 'on' : ''} onClick={() => setKind('snippet')}><FileCode2 size={14} />第三方代码片段</button>
        </div>
        <div className="form-row">
          <label>名称<input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'dependency' ? '例如 date-fns' : '例如 滑块组件片段'} /></label>
          {kind === 'dependency' && <label>版本<input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="例如 3.6.0" /></label>}
          <label>许可证<select value={license} onChange={(e) => setLicense(e.target.value)}>{LICENSES.map((l) => <option key={l}>{l}</option>)}</select></label>
        </div>
        <div className="form-row">
          <label>版权方<input value={holder} onChange={(e) => setHolder(e.target.value)} placeholder="署名所用版权人" /></label>
          <label className="grow">源码链接<input value={originUrl} onChange={(e) => setOriginUrl(e.target.value)} placeholder="https://…" /></label>
        </div>
        {kind === 'snippet' && <label className="block">片段代码（指纹按归一化代码计算，空白差异不影响归并）<textarea rows={4} value={code} onChange={(e) => setCode(e.target.value)} /></label>}
        <label className="check"><input type="checkbox" checked={modified} onChange={(e) => setModified(e.target.checked)} />该来源被修改过（Apache/GPL/MPL/EPL 等将产生修改披露义务）</label>
        {modified && <label className="block">修改说明<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="修改了什么" /></label>}
        <button className="primary full" onClick={submit}>计算指纹并登记</button>
      </div>
    </div>
  );
}
