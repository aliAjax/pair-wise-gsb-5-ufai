// 领域模型：来源（依赖 / 第三方片段）→ 许可义务 → 发布物 → 发布批次 → 写入作业 → 审计
// 所有跨批次、跨重算需要稳定归并的对象，一律以「来源指纹 fingerprint」为主键。

export type SourceKind = 'dependency' | 'snippet';

/** 一条来源记录。同一指纹可能有多条记录（重复粘贴/多处登记），归并后只产生一份义务。 */
export interface SourceRecord {
  id: string;
  /** SHA-256 来源指纹；旧数据为 null，迁移前不得进入可发布报告 */
  fingerprint: string | null;
  kind: SourceKind;
  name: string;
  version?: string;
  license: string;
  originUrl?: string;
  copyrightHolder?: string;
  /** 片段：原始代码（用于计算指纹与源码交付）；依赖：留空 */
  code?: string;
  modified: boolean;
  modificationNote?: string;
  addedAt: number;
  /** 旧系统遗留数据，等待指纹迁移 */
  legacy?: boolean;
  /** 指纹迁移/归并时，被并入本条的其它记录 id */
  mergedFrom?: string[];
  migratedAt?: number;
}

export type ObligationKind = 'attribution' | 'sourceOffer' | 'modDisclosure';

export const OBLIGATION_LABEL: Record<ObligationKind, string> = {
  attribution: '署名',
  sourceOffer: '源码交付',
  modDisclosure: '修改披露',
};

/** 发布物范围内、按来源指纹生成的一项许可义务 */
export interface Obligation {
  /** 稳定键：指纹 × 义务类型；重算时据此保留已完成状态与证据 */
  key: string;
  sourceFingerprint: string;
  sourceName: string;
  kind: ObligationKind;
  license: string;
  detail: string;
  status: 'pending' | 'satisfied';
  evidence?: string;
  /** 生成该义务时的依据指纹，冻结批次据此保留「原依据」 */
  basisFingerprint: string;
  updatedAt: number;
  satisfiedAt?: number;
}

export interface SourceRef {
  fingerprint: string;
  recordId: string;
  name: string;
  version?: string;
  license: string;
  kind: SourceKind;
  modified: boolean;
}

export type ReleaseStatus = 'draft' | 'ready' | 'interrupted' | 'published';

export interface ScopeChange {
  added: string[]; // fingerprints
  removed: { fingerprint: string; name: string; at: number }[];
}

/** 一个发布物（artifact）：范围 + 义务 + 依据，可增量重算 */
export interface Release {
  id: string;
  label: string;
  status: ReleaseStatus;
  scopeFingerprints: string[];
  refs: SourceRef[];
  obligations: Obligation[];
  changes: ScopeChange;
  createdAt: number;
  updatedAt: number;
}

export interface FrozenSnapshot {
  frozenAt: number;
  reportDigest: string;
  releases: {
    releaseId: string;
    label: string;
    refs: SourceRef[];
    obligations: Obligation[];
  }[];
}

export interface DiffEntry {
  type: 'digest' | 'release-missing' | 'release-extra' | 'obligation';
  subject: string;
  winner: string;
  late: string;
}

export interface ConfirmationAttempt {
  id: string;
  owner: string;
  receivedAt: number;
  role: 'winner' | 'late';
  materialDigest: string;
  materialReleaseIds: string[];
  note: string;
  diff?: DiffEntry[];
}

export interface Batch {
  id: string;
  name: string;
  state: 'open' | 'frozen' | 'confirmed';
  releaseIds: string[];
  frozen?: FrozenSnapshot;
  confirmations: ConfirmationAttempt[];
  /** 先到确认的 attempt id —— 形成版本；后到者永不覆盖 */
  winnerAttemptId?: string;
  createdAt: number;
}

export type JobStepKind =
  | 'scope-snapshot'
  | 'attribution'
  | 'sourceOffer'
  | 'modDisclosure'
  | 'report'
  | 'release-audit';

export interface JobStep {
  /** 幂等键：重试时据此跳过，义务与审计绝不重复生成 */
  idempotencyKey: string;
  releaseId: string;
  kind: JobStepKind;
  title: string;
  state: 'pending' | 'done' | 'skipped-duplicate';
  attempts: number;
  doneAt?: number;
}

export interface WriteJob {
  id: string;
  batchId: string;
  /** 按发布物顺序展开；续作时从最后一个完整发布物之后继续 */
  steps: JobStep[];
  state: 'running' | 'interrupted' | 'complete';
  startedAt: number;
  finishedAt?: number;
}

export interface AuditEntry {
  id: string;
  /** 幂等键，与作业步骤键一致；重复重试不再产生第二条记录。事件类审计可省略 */
  idempotencyKey?: string;
  ts: number;
  action: string;
  detail: string;
  releaseId?: string;
  batchId?: string;
}

export interface AppState {
  bootstrapped: boolean;
  sources: SourceRecord[];
  releases: Release[];
  batches: Batch[];
  jobs: WriteJob[];
  audit: AuditEntry[];
  migration: { running: boolean; done: number; total: number };
  seq: number;
}
