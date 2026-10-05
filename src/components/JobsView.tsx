import { useState } from 'react';
import { useStore, advanceJob } from '../store';
import { lastCompleteReleaseIndex } from '../lib/engine';
import {
  AlertOctagon, CheckCircle2, ChevronRight, FileCheck2, Play, RotateCcw, Zap,
} from 'lucide-react';

export default function JobsView() {
  const { state, act } = useStore();
  const [busyJob, setBusyJob] = useState<string | null>(null);

  // 逐拍执行：一次只推进一步，便于观察「中断 → 续作」
  const tick = (jobId: string, crash = false) => act((s) => advanceJob(s, jobId, Date.now(), crash));

  /**
   * 连续执行；用 refState 随每次 dispatch 更新保持快照新鲜。
   * crashAtDone=3 表示：在已经完成 3 步后（第一个发布物写到一半）注入一次写入失败，
   * 之后自动继续——直接演示「从最后一个完整发布物之后续作、重试不重复落库」。
   */
  const autoRun = async (jobId: string, crashAfterDone = -1) => {
    setBusyJob(jobId);
    let refState = state;
    let crashed = false;
    for (let i = 0; i < 400; i++) {
      const job = refState.jobs.find((j) => j.id === jobId);
      if (!job || job.state === 'complete') break;
      const doneCount = job.steps.filter((s) => s.state === 'done').length;
      const doCrash = crashAfterDone >= 0 && !crashed && doneCount === crashAfterDone;
      await new Promise((r) => setTimeout(r, doCrash ? 500 : 160));
      // 基于自有快照在更新函数外计算（保持更新函数纯，兼容 StrictMode 双调用）
      const next = advanceJob(refState, jobId, Date.now(), doCrash);
      refState = next;
      act(() => next);
      if (doCrash) crashed = true;
    }
    setBusyJob(null);
  };

  return (
    <div className="view">
      <div className="view-head">
        <div><h2>写入续作</h2><p>写入按发布物顺序展开：范围快照 → 署名 → 源码交付 → 修改披露 → 报告 → 发布审计。中断后从最后一个完整发布物之后继续，重试不重复生成义务或审计记录。</p></div>
      </div>

      {state.jobs.length === 0 && <div className="card empty">还没有写入作业——请在「发布批次」中确认批次后创建。</div>}

      <div className="jobs">
        {[...state.jobs].reverse().map((job) => {
          const batch = state.batches.find((b) => b.id === job.batchId);
          const done = job.steps.filter((s) => s.state === 'done').length;
          const pct = Math.round((done / job.steps.length) * 100);
          const releaseOrder: string[] = [];
          for (const s of job.steps) if (!releaseOrder.includes(s.releaseId)) releaseOrder.push(s.releaseId);
          const lastComplete = lastCompleteReleaseIndex(job);
          const releaseLabel = (rid: string) =>
            batch?.frozen?.releases.find((r) => r.releaseId === rid)?.label
            ?? state.releases.find((r) => r.id === rid)?.label ?? rid;

          return (
          <div key={job.id} className="card job-card">
            <div className="job-head">
              <div>
                <h3><FileCheck2 size={15} />{batch?.name ?? job.batchId} 的写入作业</h3>
                <p>{done}/{job.steps.length} 步骤完成 · 开始于 {new Date(job.startedAt).toLocaleString()}</p>
              </div>
              <div className="job-state">
                {job.state === 'running' && <i className="js running"><Play size={12} />进行中</i>}
                {job.state === 'interrupted' && <i className="js interrupted"><AlertOctagon size={12} />写入中断</i>}
                {job.state === 'complete' && <i className="js complete"><CheckCircle2 size={12} />已完成</i>}
              </div>
            </div>
            <div className="job-bar"><div style={{ width: `${pct}%` }} className={job.state} /></div>
            {job.state === 'interrupted' && (
              <div className="resume-hint">
                <RotateCcw size={13} />
                <div><b>从断点续作</b>
                  <p>最后一个完整发布物：{lastComplete >= 0 ? releaseLabel(releaseOrder[lastComplete]) : '无'}；
                  重试从其之后的发布物第一步继续。待执行步骤已尝试 {job.steps.find((s) => s.state === 'pending')?.attempts ?? 0} 次，义务与审计按幂等键去重，不会重复生成。</p>
                </div>
              </div>
            )}

            <div className="job-releases">
              {releaseOrder.map((rid, idx) => {
                const steps = job.steps.filter((s) => s.releaseId === rid);
                const allDone = steps.every((s) => s.state === 'done');
                const complete = idx <= lastComplete;
                const inProgress = !allDone && (idx === lastComplete + 1 || (lastComplete === -1 && idx === 0));
                return (
                  <div key={rid} className={`job-release ${complete ? 'complete' : ''} ${inProgress ? 'active' : ''}`}>
                    <div className="jr-head">
                      {complete ? <CheckCircle2 size={14} className="ok-ic" /> : inProgress ? <ChevronRight size={14} className="pend-ic" /> : <i className="jr-dot" />}
                      <b>{releaseLabel(rid)}</b>
                      <span className="jr-count">{steps.filter((s) => s.state === 'done').length}/{steps.length}</span>
                      {complete && <i className="sealed">已封存审计</i>}
                    </div>
                    <div className="jr-steps">
                      {steps.map((s) => (
                        <div key={s.idempotencyKey} className={`jr-step ${s.state} ${s.attempts > 1 ? 'retried' : ''}`}>
                          {s.state === 'done' ? <CheckCircle2 size={12} /> : <i className="empty-circle" />}
                          <span>{s.title}</span>
                          {s.attempts > 1 && <i className="attempts-badge">尝试 {s.attempts} 次 · 未重复落库</i>}
                          <span className="mono key">{s.idempotencyKey.split(':').slice(2).join(':')}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            {job.state !== 'complete' && (
              <div className="job-controls">
                <button className="primary" disabled={busyJob === job.id} onClick={() => tick(job.id)}><Play size={14} />推进一步</button>
                <button className="outline" disabled={busyJob === job.id} onClick={() => tick(job.id, true)}><Zap size={14} />模拟当前步写入失败</button>
                <button className="outline" disabled={busyJob === job.id} onClick={() => autoRun(job.id)}>连续执行至完成</button>
                <button className="outline danger" disabled={busyJob === job.id} onClick={() => autoRun(job.id, 3)}>连续执行（第 4 步注入中断后自动续作）</button>
              </div>
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}
