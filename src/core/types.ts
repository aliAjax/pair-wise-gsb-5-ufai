// 发布合规清单的领域模型。
// 核心不变量：
//  - 第三方来源（依赖 / 代码片段）以指纹为身份，按指纹归并；
//  - 义务按 (批次, 指纹, 义务类型) 稳定编号，重算只动受影响指纹；
//  - 已冻结批次只保留冻结时的依据快照，之后的范围变化不再影响它。

export type RefKind = 'dependency' | 'snippet';

/** 一个来源在发布物中的具体引用位置 */
export interface SourceRef {
  id: string;
  kind: RefKind;
  /** 依赖：包清单路径；片段：粘贴所在文件 / 行段 */
  location: string;
  /** 片段或依赖被撤下后，引用保留记录但退出发布范围 */
  removed?: boolean;
  /** 我方是否修改过该副本（触发修改披露义务） */
  modified?: boolean;
  /** 旧数据迁移而来的引用 */
  legacy?: boolean;
}

/** 归并后的第三方来源 */
export interface SourceRecord {
  /** 本地记录 id（迁移归并时稳定，义务/发布物通过它引用） */
  id: string;
  /** 规范指纹；旧数据迁移前为空串 */
  fingerprint: string;
  name: string;
  version?: string;
  /** 上游标识（包仓库 URL / 片段来源页），参与指纹计算 */
  upstream?: string;
  license: string;
  refs: SourceRef[];
}

export type ObligationType = 'attribution' | 'sourceOffer' | 'modificationDisclosure';
export type ObligationStatus = 'pending' | 'satisfied' | 'withdrawn';

export interface Obligation {
  /** 稳定编号：批次:来源记录:类型 —— 重试与重算据此幂等 */
  key: string;
  batchId: string;
  sourceId: string;
  fingerprint: string;
  type: ObligationType;
  status: ObligationStatus;
  /** 需要交付的材料描述（署名文本 / 源码包 / 修改说明） */
  material: string;
  /** 依据：许可证条款或补全要求 */
  basis: string;
  evidence?: string;
  owner?: string;
  createdAt: number;
  satisfiedAt?: number;
}

/** 发布物（批次内的交付单元，中断恢复以它为边界） */
export interface Artifact {
  id: string;
  name: string;
  /** 包含的来源记录 id（迁移归并时自动跟随别名） */
  sourceIds: string[];
}

export interface ScopeSig {
  /** 该来源出现在哪些发布物 */
  artifacts: string[];
  /** 是否存在被修改的活动引用 */
  modified: boolean;
  /** 活动引用是否还存在于发布范围 */
  present: boolean;
  license: string;
  version?: string;
}

export interface FrozenBasis {
  frozenAt: number;
  /** 冻结瞬间的来源快照（含引用与许可证，撤下也不改变） */
  sources: Array<{
    id: string;
    fingerprint: string;
    name: string;
    version?: string;
    license: string;
    refs: SourceRef[];
  }>;
  obligations: Obligation[];
  artifacts: Artifact[];
  scopeSig: Record<string, ScopeSig>;
  note: string;
}

export interface MaterialDiffEntry {
  obKey: string;
  label: string;
  winner?: string;
  later?: string;
  verdict: 'same' | 'changed' | 'only-winner' | 'only-later';
}

export interface Confirmation {
  idemKey: string;
  owner: string;
  at: number;
  winner: boolean;
  /** 负责人随确认提交的材料：义务编号 -> 材料/证据说明 */
  materials: Record<string, string>;
  /** 后到者相对先到版本的差异（仅后到确认携带） */
  diff?: MaterialDiffEntry[];
}

export type BatchStatus = 'open' | 'frozen' | 'confirmed';

export interface Batch {
  id: string;
  name: string;
  /** 两位负责人可能确认出分歧，保留材料另开版本时递增 */
  version: number;
  status: BatchStatus;
  artifactIds: string[];
  /** 续作检查点：只记录已完整处理完的发布物 */
  processedArtifacts: string[];
  /** 上次范围签名，范围变化时只重算签名改变的指纹 */
  scopeSig: Record<string, ScopeSig>;
  obligations: Obligation[];
  confirmations: Confirmation[];
  frozenBasis?: FrozenBasis;
  /** 已出具报告的幂等键，重复出具不产生新审计 */
  reportKeys: string[];
  interruptedAt?: number;
  createdAt: number;
}

export interface AuditEvent {
  seq: number;
  at: number;
  type: string;
  batchId?: string;
  detail: string;
  idemKey?: string;
}

export interface AppState {
  sources: SourceRecord[];
  artifacts: Record<string, Artifact>;
  batches: Batch[];
  audit: AuditEvent[];
  /** 已消费的幂等键：重试不重复生成义务、确认或审计记录 */
  idemSeen: string[];
  /** 迁移归并：旧记录 id -> 归并后记录 id */
  alias: Record<string, string>;
  seq: number;
}

export interface RunResult {
  blocked?: 'legacy' | 'frozen';
  interrupted?: boolean;
  processedThisRun: string[];
  changedFingerprints: string[];
}
