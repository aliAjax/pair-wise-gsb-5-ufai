# License Lens · 发布合规续作清单

把**依赖、代码片段引用、许可义务、发布批次**接成一条可续作的流水线。
核心是一套纯函数状态机（`src/core/`），React 工作台（`src/ui/`）只负责操作与展示，
状态整体持久化到 `localStorage`。

## 需求 → 实现

| 要求 | 实现 |
|---|---|
| 依赖与代码片段进入同一发布物 | `SourceRef(kind: dependency|snippet)` 挂在按指纹归并的 `SourceRecord` 下；发布物 `Artifact` 只引用来源 id |
| 撤下片段后署名/源码链接残留 | 引用撤下只标记 `removed` 并留痕；`reconcile` 把受影响义务置为 `withdrawn`，报告不再包含其署名/源码条目 |
| 每个来源按指纹归并 | 指纹 = `cyrb53(上游 § 名称(小写) § 版本)`（`fingerprint.ts`）；`ingestSource` 同指纹自动合并引用，接入位置去重 |
| 范围变化只重算受影响署名/源码/修改披露 | 每个批次保存 `scopeSig`（发布物集合、是否修改、是否在场、许可证/版本）；逐指纹比较，签名未变的来源完全不重算 |
| 已冻结批次保留原依据 | `freezeBatch` 深拷贝来源引用、义务、发布物、签名为 `frozenBasis` 快照；之后撤下/改许可证只影响开放批次，报告读取快照 |
| 两位负责人确认同一批次 | `confirmBatch`：先到者 CAS 式形成版本（`status=confirmed`），后到者材料保留并按义务逐项 diff（`same/changed/only-*`）；可据此 `reopenAsNewVersion`，旧版本不动 |
| 写入中断后从最后一个完整发布物继续 | `runChecklist` 以发布物为检查点：处理完一个才追加到 `processedArtifacts`；`failAfter` 注入中断后，同一请求重试从下一发布物继续 |
| 重试不重复生成义务或审计记录 | 义务编号稳定为 `批次:来源:类型`，upsert 不重复；完成后的相同幂等键空操作；检查点跳过已处理发布物；报告出具按幂等键去重（`idemSeen` / `reportKeys`） |
| 旧数据没有指纹先迁移 | 旧记录 `fingerprint: ''`；`migrateLegacy` 补指纹、同指纹合并、别名重定向（`alias`）、开放批次重建义务。迁移前 `runChecklist` 返回 `blocked:'legacy'` |
| 未处理义务不进可发布报告 | `buildReport` 的闸门：无指纹旧数据 / `UNKNOWN` 许可证 / 挂起义务 / 中断未续 / 未双确认；`issueReport` 仅在闸门全过时出具 |

许可证义务推导（`requiredObligations`）：

- MIT / BSD：署名（版权与许可声明保留）
- Apache-2.0：署名；我方修改过副本时加修改披露
- GPL / AGPL / LGPL：署名 + 源码获取方式；修改时加修改披露
- UNKNOWN：**不产生义务**，只挂“许可证补全”闸门

## 目录

```
src/core/
  types.ts        领域模型（来源/引用/义务/发布物/批次/快照/审计）
  fingerprint.ts  指纹哈希 + 许可证族义务推导
  engine.ts       纯函数 reducer：接入/撤下/迁移/批次/续跑/冻结/双确认/报告
  seed.ts         演示数据（含 3 条待迁移旧数据、UNKNOWN 许可证、GPL 修改副本）
  store.ts        React 状态容器 + localStorage 持久化
  engine.test.ts  13 个不变量测试（node:test）
src/ui/           来源表 / 批次 / 续作清单（含中断模拟）/ 报告 / 审计 五个视图
```

## 命令

```bash
npm install
npm test       # tsc 编译核心 + node:test（13 个测试）
npm run dev    # 工作台
npm run build  # 类型检查 + 生产构建
```

## 建议的演示路径

1. **来源注册表**：看到 3 条“旧数据” → 点“先完成指纹迁移”，两条 highlight.js 按指纹合并；
2. **批次 → 续作清单**：勾选“模拟写入中断”（处理 1 个发布物后中断）→ “同请求重试/续跑”从第 2 个发布物继续，再重试显示无新工作、审计无重复；
3. 顶部切换负责人身份，在来源表把 `mystery-reader` 的 UNKNOWN 补全为 MIT；
4. 在清单中回车交付义务材料 → 冻结批次；
5. 冻结后再去来源表撤下 `pdf-embed-gpl`，回到报告确认本版本仍保留原依据；
6. 用 Alice 确认（先到）→ 切到 Bob 确认（后到，材料不同 → 差异列表）→ 可另开 v2；
7. **发布报告**：闸门全过后出具，重复出具不产生第二条审计。
