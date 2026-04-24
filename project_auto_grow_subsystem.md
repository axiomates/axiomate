---
name: Auto-grow 子系统现状（DEV-gated，dev build 激活）
description: extractMemories + autoDream + findRelevantMemories + prefetch 闭环；release 关 / dev 开 / opt-in 设置；未来 RAG 重建时不复用源码
type: project
originSessionId: 935d7d15-2fd6-4de0-9b95-b62085b7ed3e
---

# Auto-grow 子系统现状

**Status**：源码完整存在但 release 用户用不到（2026-04-24 调查）。本会话用户决策**保留源码不动**，仅记录形态 + 设计意图 + 未来 RAG 重建建议。

## 1. 子系统是什么

axiomate 源码里有一整套 "agent grows with you" 闭环（hermes 营销话术等价物）：

- **WRITE 端**：每个 query loop 结束 → forked agent（共享 prompt cache）看完 transcript → 自动萃取 durable facts → 写新 memory 文件到 `~/.axiomate/projects/<x>/memory/`
- **READ 端**：每个 user turn → midModel 看所有 memory frontmatter → 选 top-5 → 注入 attachment 给主模型
- **autoDream**：周期性后台 forked agent 跑 consolidation（合并/去重 memory）

闭环 = 你做事 → extract 自动萃取（写）→ 下次提问 → 相关 memory 自动注入（读）→ LLM 看到上次 learnings 复用。

## 2. 物理位置

- `agent/src/services/extractMemories/` —— 3 文件 662 LOC（`extractMemories.ts` / `extractMemoriesEnabled.ts` / `prompts.ts`）
- `agent/src/services/autoDream/` —— 4 文件 481 LOC（`autoDream.ts` / `config.ts` / `consolidationLock.ts` / `consolidationPrompt.ts`）
- `agent/src/tasks/DreamTask/` —— autoDream 的 UI task tracker
- `agent/src/memdir/findRelevantMemories.ts` —— 133 LOC，prefetch 的 ranking 逻辑
- `agent/src/utils/attachments.ts:2067-2124` —— `startRelevantMemoryPrefetch()` 入口
- `agent/src/utils/attachments.ts` 内 `getRelevantMemoryAttachments` / `MemoryPrefetch` 类型 / `RELEVANT_MEMORIES_CONFIG` / `collectSurfacedMemories` / `readMemoriesForSurfacing` —— 配套 helper（~166 LOC）
- `agent/src/query/stopHooks.ts:97-108` —— extractMemories + autoDream fire-and-forget 调用点
- `agent/src/utils/backgroundHousekeeping.ts:18-24` —— init 入口

## 3. 怎么开

| 受众 | 怎么开 |
|---|---|
| **开发者** | build 时 `AXIOMATE_BUILD_FEATURES=DEV bun build.ts ...` 让 `feature('DEV')` 编译期为 true（参考 commit `586b6f9` 把 13 个 never-fired flag 统一成 DEV gate 的语境） |
| **Release 用户的 prefetch（READ 端）** | **没办法**——`feature('DEV')` 永远 false，DCE 后通路物理不存在 |
| **Release 用户的 extract / autoDream（WRITE 端）** | settings.json `extractMemoriesEnabled: true` / `autoDreamEnabled: true` 主动开（这俩**没被 DEV 包裹**，仅默认 off） |

**关键不对称**：READ 是 DEV-only（无 runtime toggle），WRITE 有 runtime toggle。如果用户开了 WRITE 但用 release build，结果是"自动写但不自动读"——半个闭环。

## 4. 当时为何不默认开

推测（无 commit message 直接说，但符合代码现实）：

- **成本**：READ 端每 turn 一次 midModel sideQuery；WRITE 端每 turn 结束一次 forked agent；autoDream 周期性 forked agent。多 1-2x token 消耗
- **召回质量**：READ 端是 LLM-based ranking（让 midModel 看 frontmatter 选），不是 semantic embedding。同义词、改写都漏
- **Noise 污染**：WRITE 端易萃取出"用户在 X 改了 Y"这种琐碎 fact，污染 memory 池
- 实验阶段，优于直接 ship 给所有用户

## 5. 与 hermes 对照

- hermes "the agent that grows with you" 等价物：
  - WRITE：`tools/skill_manager_tool.py`（817 LOC，6 action）+ `run_agent.py:2840-2980` 后台 fork-agent review（默认 10 轮一次）
  - READ：Hindsight `auto_recall: true` 时每轮 vector 检索注入
- **关键差异**：hermes READ 端是 **vector 检索（语义近邻）**，axiomate 是 **LLM ranking（弱）**
- 这就是 `project_rag_roadmap.md` 里"axiomate 缺真 RAG"的根因之一

## 6. 未来 RAG 重建建议（与 project_rag_roadmap.md 配套）

做 RAG 用户系统时：

- **不复用** extractMemories / autoDream / findRelevantMemories / prefetch 源码 —— 设计目标差太远；现源码假设 LLM-based ranking + 单文件 memory，新架构是 vector + graph + chunked
- **保留** 静态 MEMORY.md 加载链 / `/memory` slash / `/remember` skill / `isAutoMemoryEnabled()` 基础设施 —— 与 RAG 正交
- **图设计 Type 2+3 hybrid**（本会话用户已确认）：
  - **节点**：Document（chunk of memory 文件 / session turn-pair）+ Entity（technical term / file / decision / tool）
  - **边**：`mentions(doc → entity)` 二部（NER 抽取，便宜）+ `(entity_a, relation, entity_b)` triple（LLM 抽，关系词汇表 5-10 个：uses / causes / resolves / contradicts / mentions）
  - **向量层**：bge-m3 embedding + cosine top-K
  - **查询 pipeline**：query → vector top-K → top docs 的 entities → 1-hop graph 扩展 → 合并 dedup → rerank → 注入
  - **为什么 hybrid**：单 Type 2 缺关系链（hermes Holographic 局限）；单 Type 3 缺语义近邻；Type 4 异构图对单用户 CLI 过度设计
- **触发时机**：与 `project_rag_roadmap.md` 同 —— GPU server provision + SessionSearch 实测召回不足 + 数据驻留方案敲定
- **启动时**先 ship-archive 当前 auto-grow 源码（git tag 标记 + 删除）以避免新旧两套并存

## How to apply

未来 Claude session 在用户问：
- "axiomate 是不是已经有自动 memory？" → 答见第 1+3 段（源码有但 release 用不到）
- "开始做 RAG 吧" → 答见第 6 段（图设计直接给）+ 跳到 `project_rag_roadmap.md` 看触发条件
- "为什么 prefetch 没生效" → 答见第 3 段表格（READ 端 DEV-only 无 runtime toggle）
