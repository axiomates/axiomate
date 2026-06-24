# Vendor Quirks Cookbook

实战经验记录：四家 OpenAI Chat 兼容网关的怪癖适配（DeepSeek / Kimi /
GLM / Aliyun），以及怎么把它们落到三层模板系统里。

机制本身见 [template-system.md](./template-system.md)；本文档专注**具体
模型怎么折腾**和**踩过的坑**。

## 适配范围

| Vendor | 模型 | matchBaseUrlRegex |
|---|---|---|
| `openai-chat-deepseek-official` | deepseek-v4-pro / deepseek-v4-flash | `(^\|//)api\.deepseek\.com(/\|$)` |
| `openai-chat-moonshot` | kimi-k2.5 / kimi-k2.6 / kimi-k2.7-code(-highspeed) | `api\.moonshot\.(cn\|ai)` |
| `openai-chat-glm` | GLM-5.2/5.1/5/4.7/4.6/4.5 系列 | `(?:bigmodel\.cn\|z\.ai)` |
| `openai-chat-aliyun` | qwen3.6-plus / 3.7-plus / 3.7-max / 3.6-flash | `(?:dashscope(?:-[\w]+)?\.aliyun(?:cs)?\.com\|maas\.aliyuncs\.com)` |
| `openai-chat-mimo` | mimo-v2.5 / mimo-v2.5-pro | `xiaomimimo\.com` |
| `anthropic-minimax` | MiniMax-M3 / M2.7(-highspeed) / M2.5(-highspeed) / M2.1(-highspeed) / M2 | `(?:^\|//)api\.minimax(?:i\.com\|\.io)` |

## 跨家怪癖矩阵

| 怪癖 | DeepSeek | Kimi | GLM | Aliyun (Qwen) | MiMo |
|---|---|---|---|---|---|
| thinking 开关字段 | `thinking.type: enabled/disabled` | `thinking.type: enabled/disabled`* | `thinking.type: enabled/disabled` | `enable_thinking: bool` | `thinking.type: enabled/disabled` |
| thinking 预算 | — | — | — | `thinking_budget: int` | — |
| thinking 强度 | `reasoning_effort: high/max` | — | `reasoning_effort` (仅 GLM-5.2) | 全部 null-delete（见下注 †） | — |
| 思考连续性 | tool call 时**必须回传** `reasoning_content`，否则 400 | k2.6/k2.7 用 `thinking.keep: 'all'` | `thinking.clear_thinking: false` | `preserve_thinking: bool` | tool call 时**必须回传** `reasoning_content`（同 DeepSeek/GLM） |
| 输出 token 字段 | `max_tokens`（未迁移） | `max_completion_tokens`（旧字段已弃用） | `max_tokens`（未迁移，1 ≤ x ≤ 131072） | `max_completion_tokens`（Plus≥3.5/Max≥3.7/Flash≥3.5） | `max_completion_tokens`（文档示例全用） |
| 工具流式 | — | — | — | `tool_stream: bool`（complex tool args 流式） | — |
| 采样开关 | — | — | `do_sample: bool`（默认 true，建议 coding agent 关掉） | — | — |
| 不支持的字段 | thinking 模式拒 `temperature/top_p/presence_penalty/frequency_penalty`（写了静默忽略） | — | — | — | thinking 模式下 `temperature/top_p` 服务端强制 1.0/0.95（静默忽略） |

\* k2.7-code 仅接受 `type: enabled`，传 disabled 会报错。

† Aliyun 上 `reasoning_effort` 在协议文档里仅 DeepSeek-V4 支持，Qwen 不支持。`openai-chat-aliyun` vendor 模板把 effort patch + valueMap 全 null 掉，picker 也不暴露 effort 档位 —— 所以**当前实现下 Aliyun 路径上没有任何模型会发 `reasoning_effort`**，包括 DeepSeek-on-Aliyun。如果未来真要支持 DeepSeek-V4 落 Aliyun，加一条 model template 重塞 patch + valueMap 即可。

## 每家详述

### DeepSeek（openai-chat-deepseek-official）

文档：<https://api-docs.deepseek.com/zh-cn/guides/thinking_mode>

**vendor 层**：
- `enabledPatch: { thinking: { type: 'enabled' } }`
- `disabledPatch: { thinking: { type: 'disabled' } }`
- `effort.valueMap`：`low/medium → null`，`high → 'high'`，`max → 'max'`（DS 服务端会把 low/medium 也映射到 high，但客户端直接 null 更干净）

**model 层**（`openai-chat-deepseek-v4p`）：
- `autoRoundTripReasoningContent: true`，`reasoningRoundTripFormat: 'reasoning_content'`
- 匹配 `\bdeepseek[\s\-_]*v?[\s\-_]*(\d+)`，且 ≥4（数值阈值在 matchesModel 里硬编码）

**关键约束**：
- 文档原话："**进行了工具调用的轮次，在后续所有请求中，必须完整回传 `reasoning_content`**。若您的代码中未正确回传 `reasoning_content`，API 会返回 400 报错。"
- 我们的实现是逐条 assistant 消息无条件回传——和 DeepSeek 文档的官方建议路径一致：`messages.append(response.choices[0].message)`。
- 非工具调用场景回传也不会出错（服务端 ignore）；选择无条件回传 = 多花点上下文 token，换取**零 400 风险**。

### Kimi / Moonshot（openai-chat-moonshot）

文档：<https://platform.kimi.com/docs/api/chat>

**vendor 层**：
- `enabledPatch: { thinking: { type: 'enabled' } }`、`disabledPatch: { thinking: { type: 'disabled' } }`
- `maxOutputTokensField: 'max_completion_tokens'`（Kimi 把旧的 `max_tokens` 标记 deprecated）
- `effort.patch: null`、`valueMap: { low/medium/high: null, max: 'max' }`——picker 只剩 None/Max，因为 Kimi 没有 `reasoning_effort`

**model 层差异**（三个模型）：

| 模型 | enabledPatch | disabledPatch | autoRoundTrip |
|---|---|---|---|
| `kimi-k2.7-code(-highspeed)` | `{thinking: {type:'enabled', keep:'all'}}` | **null**（删掉，传 disabled 会报错） | true |
| `kimi-k2.6` | `{thinking: {type:'enabled', keep:'all'}}` | 继承 vendor | true |
| `kimi-k2.5` | 继承 vendor（无 keep 字段） | 继承 vendor | false |

**关键约束**：
- k2.7-code 强制开 thinking + 强制 `keep:'all'`，任何其他值都报错。我们用 RFC 7396 `disabledPatch: null` 删掉继承的 disabled patch，这样 picker None 时**完全不发** thinking 字段，让服务端走自己的"始终开"默认。
- k2.5 文档里没列 `keep`，传了会报错。`autoRoundTrip` 为 false 是按文档（社区有报告说工具调用必传，跟文档冲突，暂从文档）。

### GLM / 智谱（openai-chat-glm）

文档：<https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode>

**vendor 层**：
- `enabledPatch: { thinking: { type: 'enabled', clear_thinking: false } }`
- `disabledPatch: { thinking: { type: 'disabled' } }`
- `effort: { patch: null }`——非 5.2 GLM 模型不发 reasoning_effort
- `extraBodyParams: { do_sample: false }`——确定性解码（vendor 文档明确推荐 coding/translation 关采样）
- `autoRoundTripReasoningContent: true`

**model 层**（`openai-chat-glm-5.2`）：
- 仅 GLM-5.2 重塞 `effort.patch: { reasoning_effort: '<value>' }`，valueMap `{low/medium/high → 'high', max → 'max'}`

**关键约束 / 设计要点**：
- 三件套（`do_sample`, `clear_thinking`, `autoRoundTripReasoningContent`）都对应 coding-agent 推荐设置：
  - `clear_thinking: false` 启用 Preserved Thinking——文档原话："该能力在 Coding Plan 端点默认开启、标准 API 端点默认关闭。如果你想在你的产品中开启保留式思考（**该能力主要推荐 Coding / Agent 场景使用**）"
  - GLM 文档同时明确："当你在使用'交错思考 + 工具'时，**必须显式保留 Reasoning content**"——和 DeepSeek 那条等价的硬要求
- `do_sample: false` 走的是 `extraBodyParams` 而**不是** enabledPatch——它和 thinking 开关无关，coding agent 任何时候都该确定性解码。这是 `extraBodyParams` 基础设施第一个落地用户。
- `clear_thinking: false` 反过来塞 `enabledPatch.thinking`——只在 thinking 开启时有意义。

### Aliyun / 阿里云百炼（openai-chat-aliyun）

文档：<https://bailian.console.aliyun.com>（OpenAI 兼容-Chat 页面）

**vendor 层**：
- `enabledPatch: { enable_thinking: true }`、`disabledPatch: { enable_thinking: false }`
- `budget.patch: { thinking_budget: '<budget>' }`
- `maxOutputTokensField: 'max_completion_tokens'`（Aliyun 全面迁移，旧 `max_tokens` 即将废弃）
- `effort: { patch: null, valueMap: { low/medium/high/max: null } }`——Aliyun 上 `reasoning_effort` 是 DeepSeek-V4 专用，Qwen 不支持。null-delete 整个 valueMap 让 ModelPicker 也不暴露 effort 档位

**matchBaseUrlRegex** 覆盖 8 个端点：
- `dashscope.aliyuncs.com`（国内默认）、`dashscope-us.aliyuncs.com`（美国）
- `coding.dashscope.aliyuncs.com`（Coding Plan，靠 substring 命中）
- `token-plan.cn-beijing.maas.aliyuncs.com`（Token Plan）
- `<appid>.{cn-beijing,ap-southeast-1,eu-central-1,ap-northeast-1}.maas.aliyuncs.com`（4 个区域 MaaS）

**model 层**（两个）：

| Model template | 匹配 | extraBodyParams | enabledPatch (额外) | autoRoundTrip |
|---|---|---|---|---|
| `openai-chat-qwen-plus-max-aliyun` | qwen3.[67]-plus / qwen3.7-max | `{tool_stream: true}` | `{preserve_thinking: true}` | true |
| `openai-chat-qwen-flash-aliyun` | qwen3.6-flash | `{tool_stream: true}` | — | false |

**关键约束**：
- `preserve_thinking` 只支持 plus/max≥3.6 三个模型——文档明列。Flash **不在支持列表**。
- `tool_stream: true` 4 个模型都支持，complex tool args（array/object 类型）会 chunk-by-chunk 流，不再等全部生成完——coding agent 工具调用 UX 的纯收益。
- `reasoning_effort` Aliyun 只接受 DeepSeek-V4。Qwen 静默忽略，但我们仍删干净，**避免 ModelPicker 给用户错觉**。

### MiMo / 小米米莫（openai-chat-mimo）

文档：<https://mimo.mi.com/docs/zh-CN/api/chat/openai-api>

**vendor 层**：
- `enabledPatch: { thinking: { type: 'enabled' } }`、`disabledPatch: { thinking: { type: 'disabled' } }`——和 DeepSeek/GLM 同形
- `effort: { patch: null, valueMap: { low/medium/high/max: null } }`——文档全程没出现过 `reasoning_effort`，删干净；picker 也只剩 None/On
- `maxOutputTokensField: 'max_completion_tokens'`——文档所有 cURL/Python 示例都用这个名字
- `autoRoundTripReasoningContent: true`——文档原话："在思考模式下的多轮工具调用过程中，模型会在返回 `tool_calls` 字段的同时返回 `reasoning_content` 字段。若要继续对话，建议在后续每次请求的 `messages` 数组中保留所有历史 `reasoning_content`，以获得最佳表现。"
- 不需要 model 层模板：mimo-v2.5（多模态）/ mimo-v2.5-pro（纯文本）/ mimo-v2-pro / mimo-v2-omni 的 wire 行为完全一致，vendor 模板对全家族覆盖。

**matchBaseUrlRegex** 一条覆盖 4 个端点（substring 匹配）：
- `api.xiaomimimo.com/v1`（通用站点）
- `token-plan-cn.xiaomimimo.com/v1`（中国集群 Token Plan）
- `token-plan-sgp.xiaomimimo.com/v1`（新加坡集群 Token Plan）
- `token-plan-ams.xiaomimimo.com/v1`（欧洲集群 Token Plan，阿姆斯特丹）

**关键约束**：
- 多轮工具调用必须回传 `reasoning_content`——和 DeepSeek/GLM 的硬要求等价
- 思考模式下 `mimo-v2.5/v2.5-pro/v2-pro/v2-omni` 不支持自定义 `temperature/top_p`，服务端强制 1.0/0.95（**客户端无需配合**，传了静默忽略）
- 图片支持是模型级（v2.5 多模态，v2.5-pro 纯文本）→ 走 `supportsImagesFuzzy` 而不是 vendor 模板（vendor 不能表达"同一网关，部分模型多模态"）

### MiniMax（anthropic-minimax）

文档：<https://platform.minimaxi.com/docs/api-reference/text-chat-anthropic>

这是**首个 anthropic 协议**的第三方 vendor。两个端点（wire 形状一致，仅 host 不同）：
- `api.minimaxi.com/anthropic/v1/messages` — 国内
- `api.minimax.io/anthropic/v1/messages` — 海外

**声明式 vendor 配置**（P3 之后）：
- `anthropicSdkThinkingType: 'adaptive'`——caller 直接产生 `{type:'adaptive'}`，**不再需要 enabledPatch null-delete budget_tokens 的反向 rewrite**
- `toolChoiceMap: { required: 'auto', specific: 'auto' }`——MiniMax 只接受 auto/none，其他收敛到 auto
- `dropFields: ['stop_sequences']`——schema 无此字段
- `thinkingPreservesTemperature: true`——adaptive 模式允许 temperature 0-2
- `effort/budget/anthropicThinkingField` 全部协议层 null-delete

**模型**（8 个 enum）：
- `MiniMax-M3`——多模态（文本/图片/视频），1M 上下文，128K 输出
- `MiniMax-M{2.7,2.5,2.1}(-highspeed)?`、`MiniMax-M2`——纯文本，192K 上下文，64K 输出
- `-highspeed` 是 SLA 变体，wire shape 完全相同

**关键约束**：
- `thinking.type` 只接受 `disabled` / `adaptive`——**不接受标准 Anthropic 的 `enabled`**
- 完全没有 `budget_tokens` / `output_config.effort` 概念
- M2.x 服务端强制思考开启，客户端发什么都无视
- `tool_choice` 只支持 `auto`/`none`——通过 `toolChoiceMap` 把 required/specific 收敛
- service_tier: standard/priority（priority 1.5x 价）——未暴露，需要时用户在 `modelConfig.extraParams` 透传

**架构关联**：MiniMax 适配触发了 anthropic 协议的完整 vendor template 派发对等性整理（P1+P2+P3），见 [protocol-vendor-template-parity-plan.md](./protocol-vendor-template-parity-plan.md)。当前 anthropic 协议的 vendor 表达能力与 openai-chat 完全对等。

### xAI Grok（openai-responses 协议）

xAI 走 openai-responses 协议（直连 `api.x.ai`，OpenRouter 上是 `x-ai/grok-*` 命名空间）。两个 schema 层 quirk：

- **拒绝 `service_tier`** —— OpenAI 的 scale tier system xAI 不实现，发了会 400
- **拒绝含 `/` 的 enum 值** —— tool input_schema 里如果 `enum: [...]` 含斜杠的字符串（常见于 file path 枚举），网关报 schema 错

落地（**model template** `openai-responses-grok`，不是 vendor template）：

```ts
'openai-responses-grok': {
  matchModelRegex: '^(grok-|x-ai/grok-)',
  protocol: 'openai-responses',
  dropFields: ['service_tier'],
  toolJsonSchemaFilter: 'strip-slash-enums',
}
```

**为什么是 model template 而非 vendor template**：quirk 跨多家 host（直连 xAI + OpenRouter `x-ai/` 命名空间都触发），但只针对 grok-* 模型。vendor template 按 `matchBaseUrlRegex` 派发，要么写两份（一份 `api.x.ai`、一份 `openrouter.ai/.../x-ai/`），要么覆盖不到 OpenRouter 的子路由——而 model template 按 `matchModelRegex` 派发只看模型名，一条搞定。

**`toolJsonSchemaFilter` 命名 scrubber 的设计**：R4 引入字段时刻意只支持枚举值 `'strip-slash-enums'`，不接受任意函数引用或字符串 lambda。一是避免配置层把任意行为注入 wire 路径，二是 filter 实现需要走 provider 端代码而不是 vendor 配置文件——加新 filter = 加 enum 值 + 加 helper 实现，门槛抬高是好事。

**历史**：R4 之前这条规则在 `apiRequestPreflight.ts` 里走模型名 substring 硬编码（`hasGrokResponsesModelName` helper + 一条规则注册表条目），绕开了 vendor template 系统。这违反了 P3 的设计原则"vendor template 是 wire shape 的唯一真理源"，所以 R4 把它搬进模板系统，preflight 注册表 + helper 一并删除。完整 audit 见 [parity plan 的 R 系列章节](./protocol-vendor-template-parity-plan.md#r-系列openai-responses-对等性-audit-p3-之后启动)。

## 设计原则

### 1. enabledPatch / disabledPatch / extraBodyParams 三个槽位的取舍

| 槽位 | 何时合并 | 合并语义 | 用法 |
|---|---|---|---|
| `enabledPatch` | 仅 picker thinking enabled | **deepMerge**（RFC 7396） | thinking 子字段（`thinking.type`、`thinking.keep`、`clear_thinking`、`preserve_thinking`） |
| `disabledPatch` | 仅 picker thinking disabled | **deepMerge**（RFC 7396） | thinking 关闭时的等价表达。null 表示"不发任何 thinking 字段，让服务端走默认" |
| `extraBodyParams` | **每次请求**（无条件） | **`Object.assign` 浅合并**（vendor → modelConfig.extraParams） | 和 thinking 解耦的 vendor-wide 偏好（`do_sample`、`tool_stream`） |

`extraBodyParams` 浅合并的含义：如果 vendor 设 `extraBodyParams: { advanced: { foo: 1 } }`，per-model `extraParams: { advanced: { bar: 2 } }`，结果是 `advanced: { bar: 2 }` —— vendor 的 `foo: 1` 被整体替换。要保留嵌套字段就得在 model 层显式重写 `{ advanced: { foo: 1, bar: 2 } }`。enabledPatch/disabledPatch 的 deepMerge 不一样，子字段会保留。

错误用法：
- 把 `do_sample` 塞 enabledPatch → 用户没开 thinking 就不发了，但 GLM 文档要求 coding agent 任何时候都关采样。
- 把 `tool_stream` 塞 enabledPatch → 同样问题，工具流和 thinking 无关。

### 2. RFC 7396 null-delete 的两个陷阱

**陷阱 A：vendor 顶层 `null` 在 vendor extends 链里被吞**

```ts
// ❌ 期望：删掉继承的 effort
'openai-chat-aliyun': { effort: null }
```

`resolveVendorChain` 内部 chain 起点是空 protocol synth 节点，`effort: null` 对一个还没继承的 key 是 no-op（dst 中没该 key），最终 vendor 顶层 effort 就是 undefined（被吞），到 `resolveStack` 合并 protocol 时不会触发删除。

```ts
// ✅ 正确：留个对象壳，子字段全 null
'openai-chat-aliyun': {
  effort: {
    patch: null,
    valueMap: { low: null, medium: null, high: null, max: null }
  }
}
```

子对象在 vendor 层是个具体值（不是 null），merge 进 chain 时会落到 dst.effort；再合到 protocol 层时，protocol 的 effort 已存在，子字段 null 触发删除。

**陷阱 B：picker 行为依赖 valueMap 而不仅是 patch**

`getCyclableEffortLevels`（`utils/effort.ts`）的逻辑：
- `template.effort` 不存在 → `['none']`
- `template.effort.valueMap` 不存在 → 返回所有 5 档（fallback）
- `template.effort.valueMap` 存在 → 过滤 null tier 后返回

如果只删 `effort.patch` 不动 valueMap，picker 仍会显示全部档位——只是发出去时不带 `reasoning_effort` 字段。Aliyun 的处理（patch + 全 valueMap null）是为了**picker 也不让用户选**这些无效档位。

### 3. vendor vs model 模板的归属判断

| 怪癖来源 | 归属 |
|---|---|
| 这家网关所有模型共有 | vendor 层（`openai-chat-glm` 的 `do_sample: false`） |
| 这家网关的部分模型支持 | model 层（Aliyun 的 `preserve_thinking` 仅 plus/max） |
| 这个模型跨网关都需要 | model 层 + 不限 matchVendorRegex（DeepSeek-v4p） |
| 这个模型仅在某网关上需要 | model 层 + matchVendorRegex 钉死（Kimi 三个模板都 `^openai-chat-moonshot$`） |

实战中最常见的判断错误是把"模型 + 网关组合"的怪癖塞 vendor 层，后果是其他模型也吃到了不该有的字段。

### 4. `autoRoundTripReasoningContent` 不是请求体字段

它是 history 拼接行为开关，影响 `openaiRequestAdapter` 在拼 messages 时是否把历史 assistant 消息里的 thinking 块累成 `reasoning_content` 回传。**和当前请求 thinking 是否开启无关**——即使本次 thinking off，历史里有 thinking 块的轮次也得照规则回传，不然违反 GLM/DeepSeek 的硬要求。

需要 Preserved Thinking 收益时通常成对出现：
- `enabledPatch.{vendor's preserved field}: true`（启用功能）
- `autoRoundTripReasoningContent: true`（实际把内容塞进 messages）

只设前者不设后者 = 白开（服务端找不到 reasoning_content 可保留）。

### 5. wire body cleanup：`dropFields` + `toolJsonSchemaFilter`

两个机制都在 build 路径**末尾**（vendor `extraBodyParams` 之后、SDK 调用之前）跑——属于"形状已经按业务逻辑构造好了，再做一遍 schema 兼容性清理"。

- **`dropFields: string[] | null`**——声明从 wire body 删的顶层字段。MiniMax 用它删 `stop_sequences`（schema 不含），Grok 用它删 `service_tier`（xAI 不实现）。比 `enabledPatch.field: null` 适用范围更广——后者只在 thinking 启用时跑。
- **`toolJsonSchemaFilter: 'strip-slash-enums' | null`**——命名 scrubber，跑 tool input_schema 的清洗。**只允许 enum 值，不允许任意函数引用**：filter 实现走 provider 端代码，加新 filter = 加 enum 值 + 加 helper。门槛抬高避免配置层把任意 wire-body 改写注入。

何时用哪个：
- 删顶层字段 → `dropFields`
- 改 tool schema → `toolJsonSchemaFilter`
- 改 message / thinking / 任何业务字段 → 用 enabledPatch / disabledPatch / extraBodyParams（cleanup 不该承担业务逻辑）

### 6. 输出 token 字段名是 vendor 决策

OpenAI Chat 协议里 `max_tokens`、`max_completion_tokens` 是历史遗留二选一。

- 还用 `max_tokens`：DeepSeek、GLM、SiliconFlow、OpenAI Chat 默认
- 已迁 `max_completion_tokens`：Moonshot、Aliyun、MiMo

`TemplatePatches.maxOutputTokensField: 'max_tokens' | 'max_completion_tokens' | null`。protocol 层默认 `'max_tokens'`，迁了的 vendor 在 vendor 层覆盖。**不要 hardcoded 在 provider 里**——靠 vendor 模板声明。

OpenAI Responses 是另一种字段名 `max_output_tokens`，仍 hardcoded 在 `openaiResponsesProvider` 里。R 系列 audit 时讨论过是否要把它也下放到 `maxOutputTokensField`（标记为 R1），结论是不动——Responses 协议出生就这个字段名、没有迁移历史、所有已知 vendor（xAI/OpenRouter）原样接受，下放进协议层就是 0 vendor 在用的空字段。**Selection bias 论证**见 [parity plan R1/R2 章节](./protocol-vendor-template-parity-plan.md#r1r2-selection-bias-论证)。

## 加新 Vendor 的 checklist

1. 找官方文档里的字段映射，填到"跨家怪癖矩阵"那张表里
2. vendor 层填基础三件套：`enabledPatch` / `disabledPatch` / `effort`
3. 如果输出字段不是 `max_tokens` → 设 `maxOutputTokensField`
4. 如果 vendor 推荐了 coding-agent 全局偏好（`do_sample` 之类）→ `extraBodyParams`
5. 如果 vendor schema 不含某个 1P 字段（拒绝或忽略）→ `dropFields: ['field_name']`
6. 如果 vendor 拒绝 tool input_schema 里的某种 JSON Schema pattern → 看 `toolJsonSchemaFilter` 现有 enum 是否覆盖；不覆盖就先用 `dropFields` 顶住（删 `tools` 字段太重，慎用），同时加 issue 跟踪是否扩 enum
7. matchBaseUrlRegex 覆盖**全部**端点（去 vendor 控制台抓所有区域 / Plan 的 base URL）
8. 部分模型才支持的字段 → 拆到 model 层，matchVendorRegex 钉死
9. `autoRoundTripReasoningContent`：vendor 文档要求 tool call 必传 reasoning_content / 启用 Preserved Thinking → true
10. anthropic 协议 vendor：必填 `anthropicSdkThinkingType`（`'enabled'` 或 `'adaptive'`）；视情况设 `toolChoiceMap` / `thinkingPreservesTemperature`
11. 加 vendor / model 模板测试：检查 wire body 里**该有什么没有什么**，picker `getCyclableEffortLevels` 的预期档位
12. 同步 onboarding wizard 测试：`getThinkingChoicesForVendor` + `isThinkingChoiceSupported` 在 `OnboardingProviderStep.test.ts` 都对每个 vendor 列出来允许的 thinking 档位。改 protocol 层 valueMap（比如给 anthropic 加 max）会一并影响这两条断言，加新 vendor 也要补对应 case。
13. 改协议层 valueMap → 顺手检查 `effort.test.ts` 里 `getCyclableEffortLevels(<protocol model>)` 的预期数组是否需要更新。
