import { useState } from 'react';
import { Ban, Download, FileText, ScrollText, ShieldCheck } from 'lucide-react';
import type { Store } from '../core/store';
import type { Batch } from '../core/types.js';
import { buildReport, issueReport } from '../core/engine.js';
import { OBLIGATION_LABEL } from '../core/fingerprint.js';
import { Badge, Card } from './widgets.js';

export function ReportView({ store, batch }: { store: Store; batch: Batch | undefined }) {
  const { state, commit } = store;
  const [msg, setMsg] = useState<string | null>(null);
  if (!batch) return <Card><p className="muted-p">请先选择一个发布批次。</p></Card>;

  const report = buildReport(state, batch.id);

  const publish = () => {
    const idem = `report-${batch.id}-${Date.now()}`;
    commit(d => {
      const r = issueReport(d, batch.id, idem);
      if ('error' in r) setMsg(`${r.error}：${r.report.blockers.map(b => b.message).join('；')}`);
      else setMsg(`报告已出具（幂等键 ${idem}）。相同请求重试不会产生第二条审计或第二个版本。`);
    });
  };

  const download = () => {
    const lines = [
      `# 可发布报告 · ${report.name} v${report.version}`,
      `依据：${batch.frozenBasis ? '冻结快照（保留原依据）' : '开放批次实时重算'}`,
      '',
      '## 署名 / 源码交付 / 修改披露',
      ...report.sections.map(s => `- [${OBLIGATION_LABEL[s.type]}] ${s.name}（${s.fingerprint}）— ${s.material}；依据：${s.basis}${s.evidence ? `；证据：${s.evidence}` : ''}`),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${report.name}-v${report.version}-notice.md`.replace(/\s+/g, '-');
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="view-head">
        <div>
          <h2>发布报告 · {batch.name} <Badge tone="gray">v{batch.version}</Badge></h2>
          <p>已撤下片段的署名与源码链接不会出现；冻结批次只依据快照。未处理义务不进可发布报告。</p>
        </div>
        <div className="row-gap">
          <button className="btn outline" onClick={download} disabled={report.sections.length === 0}><Download size={14} />导出清单</button>
          <button className="btn primary" disabled={!report.canPublish} onClick={publish}><FileText size={14} />出具报告</button>
        </div>
      </div>

      {msg && <Card className="notice"><span onClick={() => setMsg(null)}>×</span><p>{msg}</p></Card>}

      {!report.canPublish && (
        <Card className="gate">
          <b><Ban size={15} /> 发布闸门未通过（{report.blockers.length}）</b>
          <ul>{report.blockers.map((b, i) => <li key={i}>{b.message}</li>)}</ul>
        </Card>
      )}
      {report.canPublish && (
        <Card className="gate ok"><ShieldCheck size={16} /><b>闸门通过：迁移完成、义务全部交付、两位负责人已确认，可发布。</b></Card>
      )}

      <Card className="report-table">
        <div className="rt title-row"><span>义务条目</span><span>指纹</span><span>依据</span><span>材料证据</span></div>
        {report.sections.map((s, i) => (
          <div className="rt" key={`${s.fingerprint}-${s.type}-${i}`}>
            <span><Badge tone={s.type === 'attribution' ? 'blue' : s.type === 'sourceOffer' ? 'violet' : 'orange'}>{OBLIGATION_LABEL[s.type]}</Badge><b>{s.name}</b></span>
            <span><code className="fp">{s.fingerprint}</code></span>
            <span><small>{s.basis}</small></span>
            <span><small className="ev-cell">{s.material}{s.evidence ? <><br /><em>证据：{s.evidence}</em></> : null}</small></span>
          </div>
        ))}
        {report.sections.length === 0 && <p className="muted-p pad">当前没有可列入报告的义务（范围为空，或义务已随撤下撤回）。</p>}
      </Card>

      <Card className="basis-note">
        <ScrollText size={14} />
        {batch.frozenBasis
          ? <span>本报告依据冻结快照：{batch.frozenBasis.note}。快照中的许可证与引用即使在来源表中被修改 / 撤下，也不会改变本版本。</span>
          : <span>批次仍开放：范围每次变化后只重算受影响指纹，报告内容随之更新；冻结后即固定。</span>}
      </Card>
    </>
  );
}
