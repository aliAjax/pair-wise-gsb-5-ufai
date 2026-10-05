import { useState } from 'react';
import {
  Boxes, FileBarChart, Layers3, ScrollText, ShieldCheck, UserCircle2,
} from 'lucide-react';
import { useStore } from './core/store.js';
import { SourcesView } from './ui/SourcesView.js';
import { BatchesView } from './ui/BatchesView.js';
import { ChecklistView } from './ui/ChecklistView.js';
import { ReportView } from './ui/ReportView.js';
import { AuditView } from './ui/AuditView.js';

type Tab = 'sources' | 'batches' | 'checklist' | 'report' | 'audit';
const OWNERS = ['Alice（发布负责人）', 'Bob（发布负责人）'];

export default function App() {
  const store = useStore();
  const [tab, setTab] = useState<Tab>('sources');
  const [batchId, setBatchId] = useState<string>(store.state.batches[0]?.id ?? '');
  const [owner, setOwner] = useState(OWNERS[0]);
  const batch = store.state.batches.find(b => b.id === batchId);

  const nav: Array<{ key: Tab; label: string; icon: React.ReactNode; }> = [
    { key: 'sources', label: '来源注册表', icon: <Layers3 size={16} /> },
    { key: 'batches', label: '批次与发布物', icon: <Boxes size={16} /> },
    { key: 'checklist', label: '续作清单', icon: <ShieldCheck size={16} /> },
    { key: 'report', label: '发布报告', icon: <FileBarChart size={16} /> },
    { key: 'audit', label: '审计轨迹', icon: <ScrollText size={16} /> },
  ];

  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <div className="brand-icon"><ShieldCheck size={18} /></div>
          <div><b>License Lens</b><small>RELEASE COMPLIANCE LEDGER</small></div>
        </div>
        <div className="nav-title">WORKSPACE</div>
        {nav.map(n => (
          <button key={n.key} className={tab === n.key ? 'nav active' : 'nav'} onClick={() => setTab(n.key)}>
            {n.icon}{n.label}
          </button>
        ))}
        <div className="aside-bottom">
          <div className="mini-card">
            <ShieldCheck size={16} />
            <div>
              <b>{store.state.sources.length} 个指纹来源</b>
              <small>{store.state.sources.filter(s => !s.fingerprint).length} 个待迁移 · {store.state.batches.length} 个批次</small>
            </div>
          </div>
          <label className="user-switch">
            <UserCircle2 size={20} />
            <select value={owner} onChange={e => setOwner(e.target.value)}>
              {OWNERS.map(o => <option key={o}>{o}</option>)}
            </select>
          </label>
        </div>
      </aside>

      <main>
        {batch && tab !== 'sources' && tab !== 'batches' && (
          <div className="batch-switcher">
            <span>当前批次：</span>
            <select className="ui-input sm" value={batchId} onChange={e => setBatchId(e.target.value)}>
              {store.state.batches.map(b => <option key={b.id} value={b.id}>{b.name} · v{b.version} · {b.status}</option>)}
            </select>
          </div>
        )}
        {tab === 'sources' && <SourcesView store={store} />}
        {tab === 'batches' && <BatchesView store={store} selectedId={batchId} onSelect={id => { setBatchId(id); setTab('checklist'); }} />}
        {tab === 'checklist' && <ChecklistView store={store} batch={batch} owner={owner} onNewBatch={id => setBatchId(id)} />}
        {tab === 'report' && <ReportView store={store} batch={batch} />}
        {tab === 'audit' && <AuditView store={store} batchId={batch?.id} />}
      </main>
    </div>
  );
}
