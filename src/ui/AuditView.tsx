import { ScrollText } from 'lucide-react';
import type { Store } from '../core/store';
import { Card } from './widgets.js';

export function AuditView({ store, batchId }: { store: Store; batchId?: string }) {
  const { state } = store;
  const events = [...state.audit]
    .filter(a => !batchId || a.batchId === batchId)
    .reverse();

  return (
    <>
      <div className="view-head">
        <div>
          <h2>审计轨迹{batchId ? '（当前批次）' : '（全部）'}</h2>
          <p>义务生成 / 撤回、检查点、中断与续跑、冻结与确认、报告出具都只追加不修改；重试通过幂等键去重。</p>
        </div>
      </div>
      <Card className="audit">
        {events.map(a => (
          <div className="audit-row" key={a.seq}>
            <span className="seq">#{a.seq}</span>
            <code className="atype">{a.type}</code>
            <span className="adetail">{a.detail}</span>
            <small>{new Date(a.at).toLocaleTimeString()}</small>
            {a.idemKey && <code className="idem">{a.idemKey}</code>}
          </div>
        ))}
        {events.length === 0 && <p className="muted-p pad"><ScrollText size={14} /> 暂无审计事件。</p>}
      </Card>
    </>
  );
}
