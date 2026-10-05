import { useState } from 'react';
import {
  AlertTriangle, ChevronDown, FileCode2, FileCog, Layers3, RotateCcw,
  ScrollText, ShieldCheck,
} from 'lucide-react';
import { StoreProvider, useStore, select } from './store';
import MigrationBanner from './components/MigrationBanner';
import SourcesView from './components/SourcesView';
import ReleasesView from './components/ReleasesView';
import BatchesView from './components/BatchesView';
import JobsView from './components/JobsView';
import AuditView from './components/AuditView';

type Tab = 'sources' | 'releases' | 'batches' | 'jobs' | 'audit';

const TABS: { id: Tab; label: string; icon: typeof Layers3 }[] = [
  { id: 'sources', label: '来源指纹', icon: Layers3 },
  { id: 'releases', label: '发布物与义务', icon: FileCode2 },
  { id: 'batches', label: '发布批次', icon: ShieldCheck },
  { id: 'jobs', label: '写入续作', icon: FileCog },
  { id: 'audit', label: '审计记录', icon: ScrollText },
];

function Shell() {
  const { state, reset } = useStore();
  const [tab, setTab] = useState<Tab>('releases');
  const pendingMigration = select.pendingMigration(state).length;
  const interruptedJobs = state.jobs.filter((j) => j.state === 'interrupted').length;

  const badges: Partial<Record<Tab, { n: number; cls: string }>> = {
    sources: pendingMigration ? { n: pendingMigration, cls: 'red' } : undefined,
    jobs: interruptedJobs ? { n: interruptedJobs, cls: 'amber' } : undefined,
  };

  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <div className="brand-icon"><ShieldCheck size={18} /></div>
          <div><b>License Lens</b><small>RELEASE COMPLIANCE</small></div>
        </div>
        <div className="nav-title">合规工作流</div>
        {TABS.map((t) => (
          <button key={t.id} className={`nav ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            <t.icon size={16} />{t.label}
            {badges[t.id] && <span className={badges[t.id]!.cls}>{badges[t.id]!.n}</span>}
          </button>
        ))}
        <div className="aside-bottom">
          <div className="mini-card">
            <AlertTriangle size={16} />
            <div><b>可续作清单原则</b><small>指纹归并 · 增量重算 · 冻结留证 · 幂等续作</small></div>
          </div>
          <button className="reset-btn" onClick={() => { if (confirm('恢复演示数据？当前本地状态将被清除。')) reset(); }}>
            <RotateCcw size={12} />重置演示数据
          </button>
          <div className="user"><div className="avatar">ZL</div><span>Zen Li</span><ChevronDown size={14} /></div>
        </div>
      </aside>
      <main>
        <MigrationBanner />
        {!state.bootstrapped ? <div className="loading">正在计算来源指纹…</div> : (
          <>
            {tab === 'sources' && <SourcesView />}
            {tab === 'releases' && <ReleasesView />}
            {tab === 'batches' && <BatchesView />}
            {tab === 'jobs' && <JobsView />}
            {tab === 'audit' && <AuditView />}
          </>
        )}
      </main>
    </div>
  );
}

export default function App() {
  return <StoreProvider><Shell /></StoreProvider>;
}
