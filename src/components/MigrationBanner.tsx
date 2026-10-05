import { useStore, select } from '../store';
import { DatabaseZap, Lock } from 'lucide-react';

export default function MigrationBanner() {
  const { state, runMigration } = useStore();
  const pending = select.pendingMigration(state);
  if (pending.length === 0 && !state.migration.running) return null;

  const done = state.migration.done;
  const total = state.sources.length;
  const pct = Math.round((done / total) * 100);

  return (
    <div className="migration-banner">
      <div className="mb-icon"><DatabaseZap size={18} /></div>
      <div className="mb-body">
        <b>检测到 {pending.length} 条无来源指纹的旧数据</b>
        <p>迁移完成前，遗留来源无法加入发布物范围；未处理义务不会进入可发布报告。迁移按来源计算 SHA-256 指纹，重复片段自动归并。</p>
        <div className="mb-progress"><div style={{ width: `${pct}%` }} /></div>
        <small>{done}/{total} 已完成指纹迁移</small>
      </div>
      <div className="mb-action">
        <div className="lock-note"><Lock size={13}/> 迁移中发布物重算已锁定旧记录</div>
        <button className="primary" onClick={runMigration} disabled={state.migration.running && pending.length > 0}>
          {state.migration.running ? '迁移进行中…' : '开始迁移'}
        </button>
      </div>
    </div>
  );
}
