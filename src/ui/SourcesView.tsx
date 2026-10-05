import { useMemo, useState } from 'react';
import { Database, FileCode2, Package, RefreshCcw, Search, ShieldQuestion, Trash2 } from 'lucide-react';
import type { Store } from '../core/store.js';
import { familyOf } from '../core/fingerprint.js';
import { ingestSource, migrateLegacy, resolveLicense, withdrawRef } from '../core/engine.js';
import type { MigrationReport } from '../core/engine.js';
import { Badge, Card, Field, Modal } from './widgets.js';

const LICENSES = ['MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'LGPL-3.0', 'UNKNOWN'];

export function SourcesView({ store }: { store: Store }) {
  const { state, commit, reset } = store;
  const [query, setQuery] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ kind: 'dependency' as 'dependency' | 'snippet', name: '', version: '', upstream: '', license: 'MIT', location: '', modified: false });
  const [migration, setMigration] = useState<MigrationReport | null>(null);

  const legacyCount = state.sources.filter(s => !s.fingerprint).length;

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return state.sources
      .map(s => ({ s, activeRefs: s.refs.filter(r => !r.removed).length }))
      .filter(x => !q || x.s.name.toLowerCase().includes(q) || x.s.fingerprint.includes(q))
      .sort((a, b) => Number(!a.s.fingerprint) - Number(!b.s.fingerprint));
  }, [state.sources, query]);

  const submit = () => {
    if (!form.name.trim() || !form.location.trim()) return;
    commit(d => {
      ingestSource(d, {
        kind: form.kind, name: form.name.trim(), version: form.version.trim() || undefined,
        upstream: form.upstream.trim() || undefined, license: form.license,
        location: form.location.trim(), modified: form.modified,
      });
    });
    setShowAdd(false);
    setForm({ kind: 'dependency', name: '', version: '', upstream: '', license: 'MIT', location: '', modified: false });
  };

  return (
    <>
      <div className="view-head">
        <div>
          <h2>来源注册表 · 按指纹归并</h2>
          <p>依赖与第三方代码片段以 <code>上游 § 名称 § 版本</code> 的指纹为身份；同指纹的多份副本归并为一条来源、多个引用。</p>
        </div>
        <div className="row-gap">
          <input className="ui-input with-icon" placeholder="搜索名称 / 指纹" value={query} onChange={e => setQuery(e.target.value)} />
          <Search size={14} className="input-icon" />
          <button className="btn outline" onClick={reset}><RefreshCcw size={14} />重置演示数据</button>
          <button className="btn primary" onClick={() => setShowAdd(true)}>接入来源</button>
        </div>
      </div>

      {legacyCount > 0 && (
        <Card className="migration-banner">
          <div>
            <b><ShieldQuestion size={15} /> 检测到 {legacyCount} 条无来源指纹的旧数据</b>
            <p>迁移完成前，清单推进与报告出具会被闸门拦截；未处理义务不会进入可发布报告。</p>
          </div>
          <button className="btn warn" onClick={() => commit(d => setMigration(migrateLegacy(d)))}>
            先完成指纹迁移
          </button>
        </Card>
      )}

      {migration && !migration.alreadyDone && (
        <Card className="migration-result">
          <b>迁移完成</b>
          <p>按指纹合并重复记录 {migration.mergedGroups.length} 组（共处理 {migration.migratedRefs} 个引用）：</p>
          <ul>
            {migration.mergedGroups.map(g => (
              <li key={g.fingerprint}><code>{g.fingerprint}</code> · {g.name} · 合并 {g.mergedIds.length} 条旧记录</li>
            ))}
          </ul>
          <button className="btn ghost" onClick={() => setMigration(null)}>知道了</button>
        </Card>
      )}

      <Card className="source-table">
        <div className="st title-row">
          <span>来源（引用数）</span><span>指纹</span><span>许可证</span><span>引用位置</span><span></span>
        </div>
        {list.map(({ s, activeRefs }) => {
          const unknown = s.fingerprint && familyOf(s.license) === 'unknown';
          return (
            <div className="st" key={s.id}>
              <span className="src-name">
                {s.refs.some(r => r.kind === 'snippet') ? <FileCode2 size={14} /> : <Package size={14} />}
                <b>{s.name}</b>
                {s.version && <small>{s.version}</small>}
                <Badge tone="blue">{activeRefs} 处引用</Badge>
                {s.refs.some(r => r.modified && !r.removed) && <Badge tone="orange">已修改</Badge>}
                {activeRefs === 0 && <Badge tone="gray">已全部撤下</Badge>}
              </span>
              <span><code className="fp">{s.fingerprint || '待迁移'}</code></span>
              <span>
                {s.fingerprint
                  ? <Badge tone={unknown ? 'red' : s.license.includes('GPL') ? 'orange' : 'teal'}>{s.license}</Badge>
                  : <Badge tone="gray">旧数据</Badge>}
              </span>
              <span className="refs">
                {s.refs.map(r => (
                  <span key={r.id} className={`ref ${r.removed ? 'removed' : ''}`}>
                    <Database size={11} />
                    {r.kind === 'snippet' ? '片段' : '依赖'} · {r.location}
                    {r.modified && <em>（有修改）</em>}
                    {r.removed && <em>（已撤下，留痕）</em>}
                    {!r.removed && (
                      <button className="icon-btn" title="撤下该引用" onClick={() => commit(d => withdrawRef(d, s.id, r.id, '在界面中撤下'))}>
                        <Trash2 size={12} />
                      </button>
                    )}
                  </span>
                ))}
              </span>
              <span>
                {unknown && (
                  <select className="ui-input sm" value={s.license} onChange={e => commit(d => resolveLicense(d, s.id, e.target.value))}>
                    <option value="UNKNOWN">补全许可证…</option>
                    {LICENSES.filter(l => l !== 'UNKNOWN').map(l => <option key={l}>{l}</option>)}
                  </select>
                )}
              </span>
            </div>
          );
        })}
      </Card>

      {showAdd && (
        <Modal title="接入依赖或代码片段" onClose={() => setShowAdd(false)} width={520}>
          <div className="form-grid">
            <Field label="类型">
              <select className="ui-input" value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value as 'dependency' | 'snippet' })}>
                <option value="dependency">依赖（包清单）</option>
                <option value="snippet">代码片段（粘贴 / vendor）</option>
              </select>
            </Field>
            <Field label="名称"><input className="ui-input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="如 lodash" /></Field>
            <Field label="版本"><input className="ui-input" value={form.version} onChange={e => setForm({ ...form, version: e.target.value })} placeholder="4.17.21" /></Field>
            <Field label="上游标识（参与指纹）"><input className="ui-input" value={form.upstream} onChange={e => setForm({ ...form, upstream: e.target.value })} placeholder="仓库 / 包 / 片段来源 URL" /></Field>
            <Field label="许可证">
              <select className="ui-input" value={form.license} onChange={e => setForm({ ...form, license: e.target.value })}>
                {LICENSES.map(l => <option key={l}>{l}</option>)}
              </select>
            </Field>
            <Field label="引用位置（文件 / 清单）"><input className="ui-input" value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} placeholder="如 src/utils/fmt.ts:12-40" /></Field>
          </div>
          <label className="check"><input type="checkbox" checked={form.modified} onChange={e => setForm({ ...form, modified: e.target.checked })} /> 我方修改过该副本（触发修改披露义务）</label>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setShowAdd(false)}>取消</button>
            <button className="btn primary" onClick={submit}>按指纹接入</button>
          </div>
        </Modal>
      )}
    </>
  );
}
