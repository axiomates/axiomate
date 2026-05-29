---
name: RAG roadmap (vector + 知识图，自有 GPU server)
description: hermes Hindsight 等价的 client-server 架构愿景，已锁定决策 + 未决项 + 触发条件；待 GPU server provision 后启动
type: project
originSessionId: 935d7d15-2fd6-4de0-9b95-b62085b7ed3e
---

# RAG roadmap：vector + 知识图（client-server，自有 GPU server）

**Status**: PARKED 设计阶段（2026-04-24）。本会话决策"先记录不实施"，等 GPU server provision + SessionSearchTool 实测语义召回不足后启动。

## 1. 为什么需要

axiomate 当前 retrieval 栈：
- **SessionSearchTool**（关键词 substring + BM25 + 可选 `auxiliary.sessionSearchSummary` 摘要）—— Layer 1 关键词检索 ✅
- **findRelevantMemories**（`auxiliary.memdirRelevance` 读取 frontmatter 选 top-5 memory 文件）—— LLM-based ranking，不是向量相似度
- **startRelevantMemoryPrefetch**（attachments.ts，feature('DEV') gated）—— 每轮预取骨架已就绪

**缺口**：
- 无语义近邻（"docker submodule" 找不到 "git 容器子模块" 那条 memory）
- 无跨内容关系图（无法走"docker → 故障原因 → 配置缺失"链）
- Auto-Recall #21 的"每轮自动注入相关上下文"在弱语义下命中率有限

## 2. hermes 对照

hermes 默认免费栈：
- MEMORY.md / USER.md（axiomate 已有等价）
- session_search_tool.py（FTS5 + Gemini Flash summary，axiomate SessionSearchTool 等价）
- Holographic memory（SQLite + entity 共现 + 可选 HRR 代数复合，**axiomate 缺**）

hermes 高级栈（opt-in）：
- Hindsight cloud（Vectorize.io API，付费）
- Hindsight local_embedded（hindsight-all 包：本地 PG + ONNX 模型 + 自托管 daemon ~200-300MB）

**关键事实**：hermes 的 `is_available()` 检测无 API key 就 return False，doctor.py 明确写 "no external provider configured — this is fine"。**绝大多数 hermes 用户根本不付 Hindsight 费**，默认 Holographic 就够用。

axiomate 走自建 GPU server 路径 ≈ hermes 高级栈的等价物，但 self-hosted。

## 3. 已锁定的架构决策

| 维度 | 决策 |
|---|---|
| 服务端语言 | **Python FastAPI**（vLLM / sentence-transformers / HF 生态全在 Python） |
| 客户端 | axiomate TS，HTTP REST 调用 |
| 网络拓扑 | **跨公网**（云上 GPU server，HTTPS + token auth），任意笔记本可访问 |
| 离线降级 | 退化到现有 SessionSearchTool；LLM 体感是 explicit recall tool 仍在，不硬错 |
| 节点范围 | memory + session 两类（与 hermes 自身一致；skill / toolcall / plugin 不入图） |
| 能力目标 | 复刻 Hindsight 全套：embedding + LLM 抽取实体关系图 + 1-跳遍历 + 每轮 auto-prefetch |

## 4. 未决设计（实施前再敲定）

- **数据驻留**（最重要，未定）：
  - A. 服务端 source of truth：memory + session JSONL 全在 server。多设备同步免费，server 宕 = axiomate 广义不可用
  - B. **客户端原文 + 服务端仅索引**（推荐倾向）：原文留 ~/.axiomate，server 存 vector + graph。server 宕时仍可读原文，客户端纯关键词降级
  - C. 服务端 GPU 推理 only：server 无状态，仅 embed + extract。SQLite 在客户端。多设备不同步，但最 stateless
- **嵌入模型**：bge-m3（多语言强）/ bge-large-en / nomic-embed-text。决定 GPU VRAM 占用（1-3GB）
- **实体抽取模型**：vLLM 跑本地 7-32B（吃 server VRAM 但不付 API 费）vs 复用客户端 LLM provider（多一次 token 费但 server 轻）
- **图存储**：PostgreSQL + pgvector（成熟）vs SQLite + sqlite-vec（轻量）vs 真图 DB Neo4j（图查询强但运维重）
- **Auth**：共享 token / per-device token / OAuth
- **多项目隔离**：per-project DB vs 共享 DB + project_id 过滤
- **多用户**：仅自己 vs 团队共享

## 5. 触发条件（什么时候真做）

避免 premature 投入。同时满足下列条件再启动：

- [ ] GPU server 已 provision（云资源到位，知道 GPU 型号 + VRAM）
- [ ] SessionSearchTool 在实际使用中暴露语义召回不足，证据如：
  - 用户多次抱怨"我记得我之前问过类似的但找不到"
  - LLM 多次错过相关上下文（人工复盘场景）
- [ ] 用户有 ≥1 完整工作日块可投入（实施估 2-3 周）
- [ ] 上面 §4 的"数据驻留"维度已闭合

## 6. 暂不需要做的备选路径（已评估）

- **Holographic 复刻（无 embedding，纯 SQLite + 实体共现 + HRR）**：原本 3-5 天可实施，但既然 GPU server 路径已锁定，跳过这层中间方案，避免双重维护
- **嵌入式 ONNX local model（~150MB bundle 进 axiomate exe）**：放弃，因有 GPU server 做远程推理更优
- **商业 embedding API（OpenAI / SiliconFlow）**：放弃，长期 per-call 成本 + 隐私顾虑
- **PTC（Programmatic Tool Calling）**：与 RAG 无关，独立候选，记在 harness-engineering-report.html v4.7 priority 表

## 7. 本会话决策出处

- 用户判断"必须由 ai 模型 embedding 么"打开了"非神经路径"窗口（HRR 入选讨论）
- 用户披露 GPU server 后翻盘：跳过中间层（Holographic），直接锁定真 RAG（Hindsight 等价）
- 用户决定本会话不实施，仅记录 → 该文档诞生
- 触发记忆 conversation: 935d7d15-2fd6-4de0-9b95-b62085b7ed3e

## 8. How to apply

未来 Claude session 在用户问"开始做 RAG 吧 / 上 vector / 装 embedding"时：
1. **先读本文档** —— 不必重做 hermes 调研、不必重选技术栈
2. 检查 §5 触发条件是否满足；缺什么先补什么
3. 闭合 §4 未决项后启动，单独写实施 plan
4. ship 时更新本文档 status 从 PARKED → ACTIVE / SHIPPED，并加 v4.x banner 进 harness-engineering-report.html
