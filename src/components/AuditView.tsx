import { useState } from 'react';
import { useStore } from '../store';
import { short } from '../lib/fingerprint';
import { ScrollText, Search } from 'lucide-react';

const ACTION_LABEL: Record<string, string> = {
  'batch-frozen': '批次冻结',
  'confirm-winner': '先到确认形成版本',
  'confirm-late-retained': '后到确认保留并列差异',
  'write-job-complete': '写入作业完成',
  'migration-complete': '指纹迁移完成',
};

export default function AuditView() {
  const { state } = useStore();
  const [q, setQ] = useState('');

  // 同一幂等键只出现一次 —— 重试不会制造重复审计记录
  const rows = [...state.audit]
    .reverse()
    .filter((a) => !q || `${a.detail}${a.action}${a.idempotencyKey ?? ''}`.toLowerCase().includes(q.toLowerCase()));

  const dupKeys = state.audit.reduce<Map<string, number>>((m, a) => {
    if (a.idempotencyKey) m.set(a.idempotencyKey, (m.get(a.idempotencyKey) ?? 0) + 1);
    return m;
  }, new Map());
  const duplicated = [...dupKeys.values()].some((n) => n > 1);

  return (
    <div className="view">
      <div className="view-head">
        <div><h2>审计记录</h2><p>义务写入与报告封存均按作业步骤的幂等键记录；写入中断后重试，同一键不会出现第二条。</p></div>
        <div className="tools">
          <div className="search"><Search size={14} /><input placeholder="搜索审计" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        </div>
      </div>

      <div className={`idempotency-note ${duplicated ? 'bad' : 'good'}`}>
        <ScrollText size={14} />
        {duplicated ? '检测到重复幂等键（不应发生）' : `幂等校验通过：${state.audit.filter((a) => a.idempotencyKey).length} 条步骤审计的键全部唯一`}
      </div>

      <div className="card audit-list">
        {rows.map((a) => (
          <div key={a.id} className="audit-row">
            <i className={`audit-dot ${a.action}`} />
            <div className="audit-main">
              <b>{ACTION_LABEL[a.action] ?? stepLabel(a.action)}</b>
              <p>{a.detail}</p>
              {a.idempotencyKey && <div className="mono dim audit-key">幂等键 {short(a.idempotencyKey, 48)}</div>}
            </div>
            <time>{new Date(a.ts).toLocaleString()}</time>
          </div>
        ))}
        {rows.length === 0 && <div className="empty-pad">暂无审计记录。</div>}
      </div>
    </div>
  );
}

function stepLabel(action: string): string {
  const map: Record<string, string> = {
    'scope-snapshot': '范围快照',
    'obligation-attribution': '署名义务写入',
    'obligation-source-offer': '源码交付义务写入',
    'obligation-mod-disclosure': '修改披露义务写入',
    'report-generated': '发布报告生成',
    'release-audit-sealed': '发布审计封存',
  };
  return map[action] ?? action;
}
