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

### P3：进一步 vendor 化（按需推进，非阻塞）

| ID | 改动 | 备注 |
|---|---|---|
| **F7** | `TemplatePatches.toolChoiceMap?: { auto?, any?, specific?, none? }` 让 vendor 决定 tool_choice 映射 | gap G。MiniMax 实际场景：required → auto fallback |
| **F8** | anthropic 的 `max_tokens` 也走 `maxOutputTokensField` | gap F。低优先级 |

P3 在用户实际场景需要（例如某个 vendor 真的因为 tool_choice 报错）时再做。

---

## MiniMax 具体落地

### vendor template

```ts
'anthropic-minimax': {
  protocol: 'anthropic',
  matchBaseUrlRegex: '(?:^|//)api\\.minimaxi\\.com',

  // F1 路径不做：直接靠 enabledPatch override 把 caller 产生的
  //   {type:'enabled', budget_tokens:N}
  // 改成
  //   {type:'adaptive'}
  // 替换 type，null-delete budget_tokens

  // 协议层的 effort/budget/anthropicThinkingField 全删
  effort: {
    patch: null,
    valueMap: { low: null, medium: null, high: null, max: null },
  },
  budget: { patch: null },
  anthropicThinkingField: null,

  // disabledPatch 仍然合法（MiniMax 接受 'disabled'，M2.x 服务端忽略）
  disabledPatch: { thinking: { type: 'disabled' } },

  // enabledPatch override：替换 type 并 null-delete budget_tokens
  enabledPatch: { thinking: { type: 'adaptive', budget_tokens: null } },
},
```

### parser 现状确认

`parseModelName('MiniMax-M3')` 当前命中 `minimax` family marker（pattern
`/(minimax|abab)/`），版本提取通过 `minimax-?m?(\d+(?:\.\d+)?)` 拿到
`'m3'`。`MiniMax-M2.7-highspeed` 同理。**不需要改 parser**。

### fuzzy 表

| 模型 | context | maxOutput | supportsImages |
|---|---|---|---|
| MiniMax-M3 | 1M (1_000_000) | 128K (131_072) 推荐 | true |
| MiniMax-M2.7 / -highspeed | 待确认（推测 200K，文档主页未给但推荐 64K 输出与上限 200K 暗示） | 64K (65_536) 推荐 | false |
| MiniMax-M2.5 / -highspeed | 同上 | 64K | false |
| MiniMax-M2.1 / -highspeed | 同上 | 64K | false |
| MiniMax-M2 | 同上 | 64K | false |

**M2.x context 数字需要确认**：从模型详情页或问用户。先按 200K 落，文档明
确给数字后再调整。

### highspeed 变体

`MiniMax-M2.7` 和 `MiniMax-M2.7-highspeed` wire shape 完全相同（用户判断
"估计和普通版没有任何区别"，文档也未给出区别）。parser 把 `-highspeed`
作为 variant 后缀，但 fuzzy 表 match 时只看 family + version，所以两个都
命中同一行。

---

## 风险与权衡

### F2 caller 改动的风险

`llm.ts:1443-1468` 是 Anthropic 1P 流量的核心路径。改动需要：
- 保留 `modelSupportsAdaptiveThinking` 兜底（vendor undefined 或 vendor template
  没声明 `anthropicSdkThinkingType` 时走原逻辑）
- 不破坏 claude-opus-4 等内置模型行为
- 测试覆盖：(1) Anthropic 1P claude → 走老逻辑；(2) MiniMax → 走 adaptive；
  (3) config-driven anthropic 但 vendor 没 override → 走 enabled+budget

### Anthropic SDK 客户端校验

确认 SDK 对 `type: 'adaptive'` 不会客户端校验失败。`anthropicProvider.ts:690`
已经在 `inference()` 里写了 adaptive 分支说明 SDK 接受。但 streaming 路径
是否经过 SDK 校验需要在测试中验证 wire 真的发出去 adaptive。

### Gate 条件保留

`anthropicProvider.ts:299-303` 的 gate（`params.thinking && type !== 'disabled'`）
继续保留——只在 thinking 启用时跑 vendor template 是合理的，避免对
disabled 请求做无意义合并。F1 改动不影响这个 gate。

---

## 测试矩阵

### P1 必须覆盖

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

### P2 必须覆盖

- openai-responses extraBodyParams 透传
- anthropic extraBodyParams 透传 × 3 路径

---

## 推进顺序

1. **P1 当前提交**：F1 → F2 → F3 → F4 → MiniMax vendor + fuzzy + cookbook + tests → 单次提交推送
2. **P2 独立提交**：F5 + F6 + tests → 单次提交推送
3. **P3 后续按需**：F7 / F8 不在本计划提交范围

---

## 后续回顾点

- 追到一个支持 `tool_choice: any` 的 vendor 不存在的实例时，决定 F7 是否做
- anthropic 协议下 max_tokens 改名（如 max_completion_tokens 派生）出现时，决定 F8
- anthropic SDK 升级带来新 wire 字段时，按 P1 模式增量加 patch 字段
