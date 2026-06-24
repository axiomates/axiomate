# Protocol-Vendor Template Parity Plan

把三协议（openai-chat / openai-responses / anthropic）的 vendor template
派发能力拉齐，让 vendor template 成为**所有协议** wire shape 的唯一真理源。
本计划由 MiniMax Anthropic 兼容 API 适配触发，但范围远超单个 vendor——这次
把架构上几个长期被忽略的 gap 一次补齐。

---

## 背景与动机

之前 4 家 vendor（DeepSeek / Kimi / GLM / Aliyun）+ MiMo 的适配走的都是
openai-chat 协议，所以 vendor template 派发管道久经考验。但 MiniMax 推荐
的是 **Anthropic 兼容协议**（`POST /anthropic/v1/messages`），它有几个怪癖
正好暴露了 anthropic 协议路径上 vendor template 的派发不完整：

- `thinking.type` 只接受 `disabled` / `adaptive`，**不接受** `enabled`
- 没有 `budget_tokens` 字段
- 没有 `output_config.effort`
- M2.x 系列服务端强制思考开启
- `tool_choice` 只支持 `auto` / `none`，不支持 `any`

而我们现在的 anthropic provider 在很多地方硬编码 wire shape，导致 vendor
template 没法干净地表达这些怪癖。这不是 MiniMax 独有问题——任何未来需要
adapter 的 anthropic 兼容网关都会碰到同样的墙。所以借这次机会，把架构补齐。

---

## 当前对等性矩阵

| 派发能力 | openai-chat | openai-responses | anthropic |
|---|---|---|---|
| `applyThinkingTemplate` 主路径 | ✓ | ✓ | ✓ |
| `applyThinkingTemplate` 在 `inference()` | ✓ | ✓ | **✗ A** |
| `applyThinkingTemplate` 在 `countTokens()` | n/a | n/a | **✗ B** |
| vendor `extraBodyParams` | ✓ | **✗ C** | **✗ D** |
| vendor 决定 SDK 初始 thinking 形状 | ✓ | ✓ | **✗ E** |
| vendor 决定 max output 字段名 | ✓ | n/a | **✗ F**（次要） |
| vendor 决定 `tool_choice` 形状 | ✗ | ✗ | **✗ G** |

---

## 关键 Gap 详解

### Gap A：`anthropicProvider.inference()` 不应用 vendor template

`anthropicProvider.ts:680-693` 直接根据 `request.thinking.type` 硬编码三个
分支构造 thinking 字段，然后塞进 SDK params（line 700-724）调用，整个过程
**没有调用 `applyThinkingTemplate`**。

streaming / non-streaming-fallback 路径（line 304-315 / 511-522）已经在用
vendor template 了，但 `inference()` 路径漏掉了。后果：side query / classifier
等场景下 vendor 模板不生效。

### Gap B：`anthropicProvider.countTokens()` 硬编码 thinking

`anthropicProvider.ts:806`：
```ts
...(request.thinking && { thinking: { type: 'enabled', budget_tokens: 1024 } }),
```

写死。MiniMax 的 token count 调用会 400。优先级低（countTokens 通常是辅助
功能），但补齐是免费的。

### Gap C：openai-responses 不应用 vendor `extraBodyParams`

`openaiResponsesProvider.ts:481-482 / 648-649` 只应用 `modelConfig.extraParams`，
没应用 vendor template 的 `extraBodyParams`。和 openai-chat 的 line 578-583 /
717-722 不对等。后果：将来 openai-responses 的 vendor（比如 OpenRouter on
Responses，未来若有）想下放 vendor-wide 偏好就没办法。

### Gap D：anthropic 不应用 vendor `extraBodyParams`

`anthropicProvider.ts:296-298 / 503-504` 同 Gap C。

### Gap E：anthropic SDK 初始 thinking 形状由 caller 硬编码

这是**最深的一个 gap**。`llm.ts:1438-1468` 决定 thinking 形状的逻辑：

```ts
if (modelSupportsAdaptiveThinking(options.model)) {
  thinking = { type: 'adaptive' as const }
} else {
  thinking = { type: 'enabled', budget_tokens }
}
```

这个判断是 model-level 的（基于 model 名字 + 配置），**不是 vendor-level**。
对 Anthropic 1P 模型这工作得很好（claude-opus-4 等内置走 adaptive），但
config-driven 模型现在统一被 `modelSupportsAdaptiveThinking()` 返回 false，
强制走 `enabled+budget` 分支——MiniMax 直接 400。

后续 vendor 模板里的 `enabledPatch` 虽然能在 `applyThinkingTemplate` 阶段
override 这个形状，但 caller 已经先把 budget_tokens 硬塞进去了，需要 vendor
明确 null-delete。这个能 work 但反直觉，且依赖 caller 顺序。

### Gap F：max_tokens 字段名

openai-chat 用 `maxOutputTokensField` 表达字段名。anthropic 直接硬编码
`max_tokens`。短期没影响（Anthropic 标准就是 max_tokens），但 vendor 化让
未来兼容更容易。低优先级。

### Gap G：tool_choice 映射

`anthropicProvider.ts:712-718` 把 neutral `tool_choice` 映射到 Anthropic
`{type:'auto'|'any'|'tool'}`。MiniMax 不支持 `any`。需要 vendor 能改这个映射。

---

## 设计原则

1. **vendor template 是 wire shape 的唯一真理源**——不分协议
2. **TemplatePatches 增量化**——把硬编码在 provider 里的 wire 决策下放到
   patch 字段，每次按需引入新字段，不大动既有结构
3. **provider 不该查 model-level 函数决定 wire 形状**（`modelSupportsAdaptiveThinking`
   这种 model→protocol 强耦合检查只用于 Anthropic 1P 兜底）
4. **RFC 7396 null-delete 语义贯穿**——vendor 删继承字段是统一手段

---

## 实施分阶段

### P1：MiniMax 当前需求所需的最小集（一次提交）

读完 `paramsFromContext` (`llm.ts:1403-1558`) 和三个 anthropic caller 之后，**F1/F2 不需要做**——现有 `enabledPatch` + RFC 7396 null-delete 已经能把 MiniMax 的 wire 形状完整表达出来：

- `paramsFromContext` 给 config-driven 模型一定走 `enabled+budget` 分支（因为
  `modelSupportsAdaptiveThinking` 对 config-driven 返回 false），产生
  `{type:'enabled', budget_tokens:N}`
- `anthropicProvider` 的 `applyThinkingTemplate` 覆盖层（line 314 / 521）把 vendor
  `enabledPatch: { thinking: { type: 'adaptive', budget_tokens: null } }` 合并上去，
  得到最终 `{type:'adaptive'}` 出去

这条链路对 **streaming + non-streaming-fallback** 路径已经 work。**真正坏的**只是
inference() / countTokens() 漏跑 overlay。所以 P1 收敛到：

| ID | 改动 | 文件 |
|---|---|---|
| **F3** | `inference()` 路径接入 `applyThinkingTemplate + deepMerge`（gap A） | `anthropicProvider.ts` |
| **F4** | `countTokens()` 路径接入 `applyThinkingTemplate + deepMerge`（gap B） | `anthropicProvider.ts` |
| **F-vendor** | 加 `anthropic-minimax` vendor template | `vendorTemplates.ts` |
| **F-fuzzy** | parser 已有 `minimax` family，加 capability fuzzy 表条目（M3 / M2.x context、output、supportsImages） | `contextWindowFuzzy.ts`, `maxOutputTokensFuzzy.ts`, `supportsImagesFuzzy.ts` |
| **F-tests** | vendor 模板测试、fuzzy 表测试、anthropicProvider inference/countTokens overlay 回归测试 | `__tests__/...` |
| **F-cookbook** | `vendor-quirks-cookbook.md` 加 MiniMax 章节 + 矩阵列 | docs |

**F1/F2 不做的原因**：引入 `anthropicSdkThinkingType` 是把已经能用 `enabledPatch` 表达
的事情再做一遍的 declarative 糖衣。糖衣本身没错，但当下没有跨多 vendor 的复用需求，
徒增字段会让模板表面积变大。等真有第二个 anthropic-兼容 vendor 也需要切 adaptive 时
再抽出来。

### P2：协议横向补齐 extraBodyParams（独立提交）

| ID | 改动 | 文件 |
|---|---|---|
| **F5** | openai-responses 加 vendor `extraBodyParams` 应用（gap C，2 处 Object.assign） | `openaiResponsesProvider.ts` |
| **F6** | anthropic 加 vendor `extraBodyParams` 应用（gap D，3 处 Object.assign：streaming / non-streaming / inference） | `anthropicProvider.ts` |
| **F-tests** | 三处 wire body 透传测试 | `__tests__/...` |

### P3：进一步 vendor 化（已完成）

P3 把所有 anthropic-specific 决策点都下放到 vendor template 字段，让"产生
1P 形状再 enabledPatch null-delete"的反过来手法消失。

| ID | 改动 | 文件 |
|---|---|---|
| **F1** ✓ | `TemplatePatches.anthropicSdkThinkingType` (`'enabled' \| 'adaptive' \| null`)。caller 直接产生正确形状，不再需要 enabledPatch 反向 rewrite。anthropic 协议层未设默认值 → 默认走 `modelSupportsAdaptiveThinking()` 兜底（保留 1P 行为） | `vendorTemplates.ts`, `llm.ts` |
| **F7** ✓ | `TemplatePatches.toolChoiceMap` — vendor 决定 neutral toolChoice 怎么映射到 wire。anthropic 协议层默认 `{auto, none, required→any, specific→tool}`。MiniMax 把 required/specific 都收敛到 'auto' | `vendorTemplates.ts`, `anthropicRequestAdapter.ts`, `anthropicProvider.ts`, `llm.ts` |
| **F8** ✓ | `maxOutputTokensField` 在 anthropic 协议层默认 `'max_tokens'`。`paramsFromContext` 用动态字段名，未来 vendor 改名零代价 | `vendorTemplates.ts`, `llm.ts` |
| **dropFields** ✓ | 通用机制：vendor 声明要从 wire body 删的顶层字段。MiniMax 用它删 `stop_sequences`（schema 不含） | `vendorTemplates.ts`, `anthropicProvider.ts` |
| **thinkingPreservesTemperature** ✓ | 默认 false（保 1P 行为：thinking on 时省略 temperature）。MiniMax 设 true（adaptive 模式仍接受 0-2） | `vendorTemplates.ts`, `llm.ts` |

### 架构债处理

P3 同时清掉了 plan 调研里发现的几条债：

- **`paramsFromContext` 1P 耦合** → 在函数入口加一行 `resolveStack`，三个决策点（thinking type、temperature 省略、tool_choice 映射、max_tokens 字段名）查模板字段。1P 假设变成"模板没说话时的默认"。函数没拆，但每个 1P 假设有对应 vendor 字段可以覆写。
- **`stop_sequences` vendor 过滤** → `dropFields` 通用机制覆盖。
- **`thinking + temperature` 强耦合** → `thinkingPreservesTemperature` 字段。
- **`adjustParamsForNonStreaming` 字段保留性** → 加专门回归测试 `adjustParamsForNonStreaming.test.ts`，断言 vendor 字段 / 删除字段都不被 helper 反向写回。

仍未动的债（按优先级）：
- **prompt caching / context_management / betas** —— 1P 专属基础设施，未来 vendor 真有需要再拆。
- **message role 扩展（user_system 等）** —— axiomate 中性 message 设计上只有 user/assistant/tool，新需求触发再说。
- **anthropic SDK 校验风险** —— SDK 升级带来的新字段需要逐一检查是否经过客户端校验。每次升级附带一次 wire body smoke test 即可。

### R 系列：openai-responses 对等性 audit（P3 之后启动）

P3 把 anthropic 协议的 vendor template 表达能力补齐之后，我们做了一次反向
盘点：**openai-responses 协议路径上有没有同类未下放的硬编码？** 这是一次
预防性 audit，不是某个具体 vendor 故障驱动的。结果是 7 项发现，标记 R1-R7。

#### R1-R7 矩阵

| ID | 类别 | 项 | 判定 | 理由 |
|---|---|---|---|---|
| **R1** | 预防式 | `max_output_tokens` 字段名硬编码（`openaiResponsesProvider.ts:451 / 636`），openai-chat 路径用 `maxOutputTokensField` 派发 | **不动** | Responses API 出生就叫 `max_output_tokens`，没有 chat 那种 `max_tokens` → `max_completion_tokens` 的迁移历史。**Selection bias 论证**：vendor 主动实现 openai-responses 而不是继续暴露 chat，本身就是接受 1P 形状的信号——否则没动机做新协议。已知 vendor（xAI、OpenRouter）都原样接受。0 个真实 vendor 触发，加字段就是空转 |
| **R2** | 预防式 | `tool_choice` 三分支硬编码（`toolChoiceToOpenAIResponses` 不读 `toolChoiceMap`） | **不动** | 同 R1 的 selection bias 论证。MiniMax 收敛 tool_choice 是 anthropic 协议怪癖；Responses 端语义高度对齐 OpenAI，没有已知 vendor 改这个 |
| **R3** | bug | `body.stop = request.stopSequences`（`openaiResponsesProvider.ts:475-476`），但 OpenAI Responses API schema 无 `stop` 字段 | **删** | 翻 SDK `responses.d.ts:3642-3820` 的 `ResponseCreateParamsBase`，确认无 stop / stop_sequences。早期代码靠 SDK 宽松转发流过去，要么被服务端忽略要么 400。stopSequences 是 Chat Completions 概念误植 |
| **R4** | 架构债 | `apiRequestPreflight.ts` 用模型名 substring 识别 grok，硬编码 `delete service_tier` + 工具 schema slash-enum strip——绕过 vendor template 系统 | **重构** | 这条规则的存在本身违反 P3 的设计原则（"vendor template 是 wire shape 的唯一真理源"）。搬进 model template `openai-responses-grok`，删 preflight 注册表 |
| **R5** | 看似耦合 | `OpenAIResponsesPromptCacheCompat` 用 `promptCacheKey: true` + `codexTransportCompat: true` 两个 flag 联动伪造 codex 标头 | **不动** | 见下方 R5 深度决策记录 |
| **R6** | 极低 | 没有 anthropic 那种 thinking 提前解构（`paramsFromContext` 1P 耦合） | **不算债，是优势** | Responses 协议层一开始就把 reasoning 设计成 `reasoning.effort`，没有 enabled/adaptive 两形状切换的历史包袱 |
| **R7** | 极低 | openai-responses 协议没任何内置 vendor template，只有 R4 加的 model template | **不动** | 既清爽又留口子。Responses 协议下 vendor 极少（直连 1P + xAI + OpenRouter），把 Grok 落 model 而不是 vendor 是因为 quirk 跨多家 host（直连 + OpenRouter 都触发） |

#### R3 实施

| 改动 | 文件 |
|---|---|
| 删 `body.stop = request.stopSequences`，加注释说明 Responses API schema 无 stop 字段 | `openaiResponsesProvider.ts` |

#### R4 实施

| 改动 | 文件 |
|---|---|
| `TemplatePatches.toolJsonSchemaFilter: 'strip-slash-enums' \| null`——命名 filter 而不开放任意字符串，避免配置漏洞，扩展时按需加 enum 值即可 | `vendorTemplates.ts` |
| 内置 model template `openai-responses-grok`：`matchModelRegex: '^(grok-\|x-ai/grok-)'`，`protocol: 'openai-responses'`，`dropFields: ['service_tier']` + `toolJsonSchemaFilter: 'strip-slash-enums'`。覆盖直连 xAI 和 OpenRouter 命名空间 | `vendorTemplates.ts` |
| `openaiResponsesProvider` 加 `applyTemplatePostprocess(body, template)` 模块级 helper，在 inference / countTokens 两条 build 路径末尾跑 dropFields + toolJsonSchemaFilter（位置：vendor `extraBodyParams` 之后、`omittedRequestFields` providerHints 之前）。替换 `applyApiRequestPreflight()` 调用 | `openaiResponsesProvider.ts` |
| 删 `apiRequestPreflight.ts` + 同名测试。`hasGrokResponsesModelName` 只服务这条规则，一并删 | `apiRequestPreflight.ts`, `requestRecoveryMutations.ts` |

效果：xAI Grok 的两条 schema quirk（拒绝 `service_tier`、拒绝含 `/` 的 enum
值）从硬编码 substring 规则搬进 vendor template 系统。未来再来一个 Responses
端有类似 schema quirk 的 vendor，加一条 model template 即可，不用扩 preflight
注册表。

#### R5 深度决策记录：codex 标头伪造为什么不动

调研触发于一句话疑问：右侧 `right.codes` 配置用 `promptCacheKey: true` +
`codexTransportCompat: true` 两个 flag 联动来发 codex 系列 header，看上去像
两个本不相关的功能被强行耦合。

读完 `openaiResponsesPromptCacheCompat.ts` 之后结论是**这不是耦合，是两个
真实需求恰好都需要 stable identity**：

| Flag | 单独承担 | 双开时多出的行为 |
|---|---|---|
| `promptCacheKey: true \| string` | body 加 `prompt_cache_key` 字段（合法 OpenAI 字段，提高 prompt cache 命中率），从 `a:{projectHash}:{providerHash}:{sessionHash}` 模板派生稳定 token | 给 `codexTransportCompat` header 提供稳定的 session id 来源 |
| `codexTransportCompat: true` | 发 6 个 codex header（`User-Agent`、`originator: 'codex_exec'`、`session_id`、`x-client-request-id`、`x-codex-window-id`、`x-codex-turn-metadata`） | 单独开时 header session id 来自 `getSessionId()`，进程级，跨 session 会变 |

`buildHeaders()` line 75 第一行 `if (cfg?.codexTransportCompat !== true)
return undefined`——两个 flag 独立 gate。`promptCacheKey` 关闭时 `selection`
为 null，header 自动 fallback 到 `getSessionId()`，依然能发 codex header
（只是跨 session 不稳定）。

**为什么不拆成 `codexTransportSessionId: 'cache' | 'session' | string`**：拆出来
覆盖的只有"想发 codex header 但又不想要稳定 cache key"这个非常窄的场景，配置
长度增加却没有真实用户。当前组合"两个 flag 都开 = 完整 codex 仿真"读起来反而
比拆出来清楚。

**真正担心的是合规层面**——伪装成 codex CLI 是不是违反 OpenAI ToS / right.codes
自家 ToS。这是业务决策不是架构问题，不进 R 系列范围。

#### R1/R2 selection bias 论证

R1/R2 是"对称性强迫症"陷阱：openai-chat 路径有 `maxOutputTokensField` /
（未来的）`toolChoiceMap`，看到 openai-responses 没有就觉得不对等。但
**Responses 协议的 vendor selection bias 决定了这两个 patch 字段大概率
永远没有真实 vendor**：

- Chat Completions 是被市场卷过来的——MiniMax/Kimi/Aliyun/MiMo 实现 chat 是
  因为客户端生态全是 chat 客户端，不实现就没人用。但他们自家 schema 想怎么
  改怎么改（`max_completion_tokens` 改名、tool_choice 收敛都是这个心态的产物）。
- Responses 不一样：自愿实现 = 自愿接受 1P 形状，否则继续暴露 openai-chat
  就行了，没人逼你做新协议。chat 端能列出 4 家 vendor 在某个点上偏，Responses
  端目前 0 家。

所以 R1/R2 不只是"暂时不做"，而是**做了也没东西可挂**——加了字段进 Responses
协议层默认值需要一直配着 0 个 vendor 在用，纯空转。等真有第一个 Responses 端
怪 vendor 触发了再补，开发成本一样。

#### 仍未动的债（R 系列范围内）

- **R1/R2 的 patch 字段** —— Responses selection bias 决定基本不会触发。等触发再做
- **R5 的合规层面** —— 业务决策范围，超出架构 audit
- **R6 的 1P 耦合** —— 不算债，是 Responses 协议设计上的优势

---

## MiniMax 落地最终形态（声明式）

```ts
'anthropic-minimax': {
  protocol: 'anthropic',
  matchBaseUrlRegex: '(?:^|//)api\\.minimaxi\\.com',

  // 声明式：caller 直接产生 adaptive 形状
  anthropicSdkThinkingType: 'adaptive',

  // 只接受 auto / none —— 其他全收敛到 auto
  toolChoiceMap: { required: 'auto', specific: 'auto' },

  // schema 无 stop_sequences
  dropFields: ['stop_sequences'],

  // adaptive 模式接受 temperature 0-2
  thinkingPreservesTemperature: true,

  // 协议层 effort/budget/anthropicThinkingField 全删
  effort: { patch: null, valueMap: { low: null, medium: null, high: null, max: null } },
  budget: { patch: null },
  anthropicThinkingField: { defaultBudgetTokens: null as unknown as number },
},
```

不再需要 enabledPatch / disabledPatch—— caller 一次到位产生正确形状。

---

## 测试矩阵

### P1 已覆盖

- **vendor template 单元测试**
  - `anthropic-minimax` 自动匹配 `api.minimaxi.com`
  - `anthropic-minimax` resolved template 含 `anthropicSdkThinkingType: 'adaptive'`
  - `anthropic-minimax` `effort.patch` / `budget.patch` / `anthropicThinkingField` 都被删
  - `applyThinkingTemplate` for MiniMax: enabled → `{thinking:{type:'adaptive'}}`，没有 budget_tokens / output_config.effort

- **anthropicProvider 行为测试**（mock SDK，断言 wire body）
  - claude-opus-4 (1P) thinking enabled → `{type:'enabled', budget_tokens:N}`
  - MiniMax-M3 thinking enabled → `{type:'adaptive'}`，无 budget_tokens
  - MiniMax-M3 thinking disabled → `{type:'disabled'}`
  - MiniMax-M3 inference() 路径 → adaptive
  - MiniMax-M3 countTokens() 路径 → adaptive

- **fuzzy 表**
  - `MiniMax-M3` → context 1M / output 128K / supportsImages true
  - `MiniMax-M2.7` / `MiniMax-M2.7-highspeed` → context 200K（占位） / output 64K / supportsImages false
  - 大小写：`minimax-m3` 和 `MiniMax-M3` 同结果

### P2 已覆盖

- openai-responses extraBodyParams 透传
- anthropic extraBodyParams 透传 × 3 路径

### P3 已覆盖

- `paramsFromContext` 三个决策点（thinking type、temperature 省略、tool_choice 映射、max_tokens 字段名）查模板字段
- `adjustParamsForNonStreaming` 不反向写回 vendor 字段 / 删除字段
- claude-opus-4 走 `enabled+budget`、MiniMax 走 `adaptive` 的 wire body 断言

### R 系列已覆盖

- **R3**: 没有专门的"不发 stop"测试——SDK 类型本身排除了，加测试也只是 tautology
- **R4-A**: `TemplatePatches.toolJsonSchemaFilter` 类型检查（`tsc --noEmit`）
- **R4-B**: 6 条 vendor template 测试（`vendorTemplates.test.ts` "Grok on Responses — model template parity (R4)"）
  - `openai-responses-grok` 是 built-in model template
  - matchModelRegex 命中 `grok-*` / `x-ai/grok-*`
  - 不命中 `gpt-*` / `o3-*` / 其他协议的 grok-*
  - resolved template 携带 `dropFields: ['service_tier']` + `toolJsonSchemaFilter: 'strip-slash-enums'`
- **R4-C**: 5 条已存在的 `openaiResponsesContract.test.ts` "OpenAI Responses xAI/Grok request sanitization" 测试继续通过 vendor template 路径——确认 helper 替换没破坏行为
- **R4-D**: `privateProtocolResidue.test.ts` 兜底——`apiRequestPreflight.ts` 不在 trackedFiles 里

---

## API 路径改动总览（按 provider）

文档化总结：哪些 provider 的哪些函数被改了，对应到哪个阶段。便于回头追踪。

### `agent/src/services/api/llm.ts`（caller / paramsFromContext）

| 函数 | 改动 | 阶段 |
|---|---|---|
| `paramsFromContext` | 入口加 `resolveStack` 一行；thinking type、temperature 省略、tool_choice 映射、max_tokens 字段名四处查模板字段 | P3 |
| `paramsFromContext` | `extraBodyParams` 取自 vendor template + modelConfig 合并 | P2 |

### `agent/src/services/api/providers/anthropicProvider.ts`

| 路径 | 改动 | 阶段 |
|---|---|---|
| `inference()` | 接入 `applyThinkingTemplate + deepMerge`（之前漏跑） | P1 (F3) |
| `countTokens()` | 接入 `applyThinkingTemplate + deepMerge`（之前硬编码 enabled+1024） | P1 (F4) |
| streaming / non-streaming-fallback / inference | 三处加 vendor `extraBodyParams` 应用 | P2 (F6) |
| 三处构造 SDK params | `tool_choice` 用 `toolChoiceMap` 派发，`max_tokens` 用 `maxOutputTokensField` 字段名，`thinking` 形状直接由 `anthropicSdkThinkingType` 决定 | P3 (F1/F7/F8) |
| 三处构造 SDK params | 应用 `dropFields`（删 `stop_sequences` 等 schema 不含字段） | P3 (dropFields) |
| `inference()` / `countTokens()` thinking 形状构造 | 抽出模块级 `buildAnthropicThinkingShape` helper，与 `paramsFromContext` 的 streaming 路径决策树对齐（vendor `anthropicSdkThinkingType` → `modelSupportsAdaptiveThinking()` 1P fallback → caller 类型）；删除 `inference()` 自写的硬编码分支与 `countTokens()` 的 `budget_tokens: 1024` 硬编码 | post-R |
| `inference()` toolChoice 映射 | 用 `toolChoiceToAnthropic(choice, template.toolChoiceMap)` 适配器替代自写 `defaultMap`（streaming 路径已经在用），消除两处定义漂移 | post-R |
| createStream / non-streaming / inference / countTokens | `getResolvedTemplate()` 在每条路径**只 resolve 一次**（之前每条路径调用 3-4 次），把 streamTemplate / fallbackTemplate / inferenceTemplate / countTemplate 复用给 extraBodyParams、enabledPatch overlay、dropFields 三个消费点 | post-R |

### `agent/src/services/api/providers/openaiResponsesProvider.ts`

| 路径 | 改动 | 阶段 |
|---|---|---|
| `inference()` build 路径（line ~488） | 加 vendor `extraBodyParams` 应用 | P2 (F5) |
| `buildSDKBody()` retry 路径 | 同上 | P2 (F5) |
| `inference()` build 路径 | 删 `body.stop = request.stopSequences` | R3 |
| 两条 build 路径末尾 | 调用模块级 `applyTemplatePostprocess(body, template)` —— 跑 `dropFields` + `toolJsonSchemaFilter`。替换 `applyApiRequestPreflight()` | R4-C |
| 模块顶层 | 加 `applyTemplatePostprocess` helper（dropFields 通用 + 名 filter dispatch） | R4-C |
| imports | 删 `applyApiRequestPreflight` import | R4-D |

### `agent/src/services/api/providers/openaiProvider.ts`（openai-chat）

| 路径 | 改动 | 阶段 |
|---|---|---|
| `inference()` / `buildSDKBody()` | `max_tokens` / `max_completion_tokens` 字段名走 `maxOutputTokensField` 派发 | PR4a |
| 同上 | 已有的 vendor `extraBodyParams` 应用（基线，未改动） | — |

### `agent/src/services/api/vendorTemplates.ts`

| 改动 | 阶段 |
|---|---|
| 加 `extraBodyParams` 字段 + 协议层默认 | PR4a 基础 / P2 |
| 加 `maxOutputTokensField` + openai-chat 协议层默认 `'max_tokens'` | PR4a |
| 加 `anthropicSdkThinkingType` / `toolChoiceMap` / `dropFields` / `thinkingPreservesTemperature` | P3 |
| 加 `toolJsonSchemaFilter: 'strip-slash-enums' \| null` | R4-A |
| 加 `'anthropic-minimax'` 内置 vendor template | P1 |
| 重写 `'anthropic-minimax'` 用 P3 声明式字段 | P3 (F-vendor) |
| 加 `'openai-responses-grok'` 内置 model template | R4-B |
| openai-chat vendor 模板（moonshot / aliyun / mimo）设 `maxOutputTokensField: 'max_completion_tokens'` | PR4a |

### `agent/src/services/api/requestRecoveryMutations.ts`

| 改动 | 阶段 |
|---|---|
| 删 `hasGrokResponsesModelName` helper（只服务 preflight 规则） | R4-D |

### 新增 / 删除文件

| 文件 | 操作 | 阶段 |
|---|---|---|
| `agent/src/__tests__/unit/services/api/adjustParamsForNonStreaming.test.ts` | 新增 | P3 |
| `agent/src/services/api/apiRequestPreflight.ts` | 删除 | R4-D |
| `agent/src/__tests__/unit/services/api/apiRequestPreflight.test.ts` | 删除 | R4-D |

---

## 推进顺序（已完成）

1. **P1**：F3 + F4 + MiniMax vendor + fuzzy + cookbook + tests → ✓
2. **P2**：F5 + F6 + tests → ✓
3. **P3**：F1 + F7 + F8 + dropFields + thinkingPreservesTemperature + 重写 minimax + tests → ✓
4. **R3 + R4**：删 stop / 加 toolJsonSchemaFilter / openai-responses-grok model template / 删 preflight + tests → ✓

剩余按 trigger 触发：
- R1/R2：第一个 openai-responses 端有真实 schema quirk 的 vendor 出现
- F8（anthropic max_tokens 改名）：第一个 anthropic 兼容 vendor 改字段名
- 其他 P3 仍未动的债见 P3 章节末尾
