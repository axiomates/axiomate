# Goal 系统手测方案

Hermes `/goal` Ralph-loop 端口（commits `85d8a55a` / `88962f0b` / `d4c97fc9`）的端到端验收脚本。整套跑完 20-30 分钟，需要若干 LLM 调用（fastModel 配 Haiku/Gemini Flash 时大约 ¥1-2）。

每个 Phase 标注：**操作 → 预期 → 失败信号**。

---

## 准备

`~/.axiomate.json` 至少包含：

```json
{
  "currentModel": "claude-opus-4-7",
  "fastModel": "claude-haiku-4-5-20251001",
  "goalsMaxTurns": 20
}
```

> 没配 fastModel 也能测，但会在 Phase 2 立即触发"贵模型 warning"，建议先配齐再开始，Phase 7 单独测 warning。

启动方式（在任一干净项目目录下）：

```
pnpm run start
```

---

## Phase 1 — 命令解析（不调用 LLM）

| # | 操作 | 预期 | 失败信号 |
|---|---|---|---|
| 1.1 | `/goal` | `No active goal. Set one with /goal <text>.` | 抛错 / 别的输出 → goal command 没注册 |
| 1.2 | `/goal status` / `/goal STATUS` / `/goal status   ` | 三次输出完全一致 | 大小写敏感 / 没 trim 空格 |
| 1.3 (空 goal 下) | `/goal clear` → `/goal stop` → `/goal done` | 三次都显示 `No active goal.` | 别名漏 case |

---

## Phase 2 — 最简 Happy Path（1 轮即 done）

**2.1 设一个 trivial goal**
- 操作：`/goal 在终端用 echo 输出 "hello goal"`
- 预期 ①：立刻看到 `⊙ Goal set (20-turn budget): 在终端用 echo …`
- 预期 ②：自动 kick — **不需要再敲 Enter**，AI 直接干
- 预期 ③：Footer 出现 `⊙ Goal 0/20: 在终端用 echo …` pill
- 失败信号：要敲两次 Enter / footer 没 pill

**2.2 第一轮结束**
- 等 AI 完成（应该一轮就够）
- 预期 ①：屏幕显示 `✓ Goal achieved: <一句评审理由>`（cyan ✓）
- 预期 ②：Footer pill 消失
- 预期 ③：`/goal status` 显示 `✓ Goal done (1/1 turns): …`
- 失败信号：显示 ↻ continuation 而非 ✓ → judge 判错；显示 ⏸ → judge parse 出错

---

## Phase 3 — 多轮 Continuation（核心 Ralph loop）

**3.1 设需要 2-3 轮的 goal**
- 操作：`/goal 在 当前目录创建fib.js，然后 写一个 fibonacci 函数，跑一次 node fib.js 验证 fib(10) == 55`
- 预期：`⊙ Goal set` + 自动 kick

**3.2 第一轮末**
- 预期：`↻ Continuing toward goal (1/20): <reason>` — reason 应该说"已写但还没验证"或类似
- Footer pill 数字变 `1/20`
- transcript 里出现一条 user message 前置 **`↻`** 图标（这是续作 prompt）

**3.3 后续轮**
- 重复直到 AI 跑成功
- 预期：最终一行 `✓ Goal achieved: …`，Footer pill 消失
- 失败信号：3 轮内不收敛 → goal 描述写得不够具体；中途变 ⏸ → judge 模型挑剔或挂了

---

## Phase 4 — 手动 Pause / Resume

**4.1 设一个会跑很多轮的 goal**
- 操作：`/goal 把 π 算到第 100 位然后又算到第 200 位然后又算到第 300 位无限循环`
- 等第一轮结束（出现 ↻ continuation）

**4.2 手动 pause**
- 等第二轮 AI 完成、出现 ↻ 后**立即**敲 `/goal pause`
- 预期 ①：`⏸ Goal paused: 把 π 算到第 100 位…`
- 预期 ②：Footer pill 变黄 `⏸ Goal paused: …`
- 预期 ③：AI 不再自动启动下一轮
- 失败信号：pause 后 AI 还在自动跑 → enqueue 已塞了 continuation，pause 没拦截（已知小竞争，可接受）

**4.3 resume**
- 操作：`/goal resume`
- 预期 ①：`▶ Goal resumed: …` + 提示 "Send any message…"
- 预期 ②：**不**自动启动一轮 — 等你发消息（hermes 一致行为）

**4.4 触发下一轮**
- 操作：发任意消息（例如 `continue` 或 `keep going`）
- 预期 ①：AI 处理这条消息
- 预期 ②：末尾又一轮评审 ↻ continuation
- 预期 ③：`/goal status` 显示 turns 从 0 重新计数（resume 默认 reset budget）

**4.5 收尾**
- 操作：`/goal clear`
- 预期：`✓ Goal cleared.`，Footer pill 消失

---

## Phase 5 — Ctrl+C Auto-Pause

**5.1 设一个长任务**
- 操作：`/goal 列出 / 目录下所有文件并解释每一个`
- 等 AI 开始干（看到工具调用在跑）

**5.2 Ctrl+C 中断**
- 操作：按 `Ctrl+C`
- 预期 ①：AI 立即停止
- 预期 ②：几秒内屏幕出现 `⏸ Goal paused — turn was interrupted. Use /goal resume to continue, or /goal clear to stop.`
- 预期 ③：Footer pill 变黄
- 预期 ④：`/goal status` 显示 `⏸ Goal (paused, N/20 turns — user-interrupted (Ctrl+C)): …`
- 失败信号：中断后 ↻ continuation 继续推进 → goalHook 没正确检测 `signal.aborted`

**5.3 收尾**
- `/goal clear`

---

## Phase 6 — Subgoal

**6.1 设 goal**
- 操作：`/goal 在 /tmp/sort.js 写一个排序函数`
- 等第一轮 ↻

**6.2 中途加 subgoal**
- 操作：`/subgoal 跑一次 node /tmp/sort.js 验证`
- 预期：`✓ Added subgoal 1: 跑一次 node /tmp/sort.js 验证`
- **重要**：goal loop **不**因为这个 slash command 被打断（检查下一轮仍在自动跑）

**6.3 再加一条**
- 操作：`/subgoal 输出排序后的数组`
- 预期：`✓ Added subgoal 2: 输出排序后的数组`

**6.4 查看**
- 操作：`/subgoal`
- 预期：显示 `⊙ Goal (active, N/20 turns, 2 subgoals): …` 加 `- 1. 跑一次 …\n- 2. 输出 …`

**6.5 删一条**
- 操作：`/subgoal remove 1`
- 预期：`✓ Removed subgoal 1: 跑一次 …`
- 操作：`/subgoal`
- 预期：剩 `- 1. 输出排序后的数组`（编号重排）

**6.6 错误 case**
- 操作：`/subgoal remove abc` → 预期：`/subgoal remove: <n> must be an integer (1-based index).`
- 操作：`/subgoal remove 99` → 预期：`/subgoal remove: index out of range (1..1)`

**6.7 clear**
- 操作：`/subgoal clear`
- 预期：`✓ Cleared 1 subgoal.`

**6.8 收尾**
- `/goal clear`

---

## Phase 7 — Cost Warning（一次性 + 黄色）

**7.1 临时把 midModel / fastModel 都移走**
- 编辑 `~/.axiomate.json`，删 `midModel` 和 `fastModel` 两个字段（如果有）
- 删 `goalJudgeCostWarned` 字段（如果有 — 这是 axiomate 用来记"warning 已经显示过"的 flag）
- 退出 axiomate，重新 `pnpm run start`

**7.2 第一次 /goal — 应看到黄色 warning**
- 操作：`/goal 输出 hi`
- 预期：`⊙ Goal set (...)` 下方一行**黄色**文字：
  `⚠ Goal judge will use the main model (claude-opus-4-7). Set fastModel or midModel in ~/.axiomate.json to a cheaper model to lower per-turn cost. (This warning is shown once.)`
- 失败信号：没 warning → cost detection 逻辑挂了；warning 是红色 → chalk 颜色错了

**7.3 第二次 /goal — warning 应该消失**
- 操作：`/goal clear`（先收尾上一个）
- 操作：`/goal 再输出 hi`
- 预期：`⊙ Goal set (...)` **没有** warning 行（一次性提示已写进 `goalJudgeCostWarned: true`）
- 失败信号：又出 warning → 一次性 flag 没生效

**7.4 验证 flag**
- 退出 axiomate，cat `~/.axiomate.json` 应该有 `"goalJudgeCostWarned": true`

**7.5 恢复**
- 把 fastModel 加回 `~/.axiomate.json`
- 把 `goalJudgeCostWarned` 删掉（或保留 — 反正没配 fastModel 才会触发）
- 重启

---

## Phase 8 — Persistence + Resume

**8.1 跑一半**
- 操作：`/goal 做某个长任务`（用 Phase 3 的 fib 例子）
- 等到出现 1-2 个 ↻ continuation

**8.2 退出**
- 操作：`Ctrl+C` 两次（或 `/exit`），关 axiomate 进程
- 预期 ①：退出前 goal state 已持久化到 jsonl
- 验证：`grep "goal-state" ~/.axiomate/projects/<hash>/<sessionId>.jsonl | tail -3` 应看到几条 goal-state 条目

**8.3 resume**
- 操作：`axiomate --continue` 或新进程内 `/resume`
- 预期 ①：Footer pill **立刻**显示 `⊙ Goal N/20: …` 或 `⏸ Goal paused: …`
- 预期 ②：`/goal status` 显示完整保留的状态（turns/subgoals 都在）
- 失败信号：Footer 没 pill → useGoalState hydrate 失败；状态空 → loadGoalState 没读到 jsonl 条目

**8.4 继续**
- 操作：发任意消息触发下一轮
- 预期：评审正常跑，turn 计数从持久化值继续累加

---

## Phase 9 — Fork 隔离

**9.1 设 goal**
- `/goal 写个 hello world`，等到完成或留在 active

**9.2 fork**
- 操作：`/branch <new-name>`（具体语法看 `/help branch`）
- 等 fork 完成 + 切到新 session

**9.3 检查**
- 操作：`/goal status`
- 预期：`No active goal. Set one with /goal <text>.`
- 预期：新 session 的 Footer 没 pill

**9.4 验证 jsonl**
- `grep "goal-state" ~/.axiomate/projects/<hash>/<newSessionId>.jsonl` → 应为空（fork 没复制 goal-state）

---

## Phase 10 — 用户消息抢占

**10.1 启动**
- `/goal 做 X 任务`，等到第一轮 ↻
- AI 开始第二轮

**10.2 中途打字**
- 在 AI 第二轮还在干的时候**敲一条消息**：`等一下，先告诉我你看到了什么文件`
- 预期 ①：等当前 AI tool round 结束
- 预期 ②：你的消息作为下一轮 user input 处理（**不是** continuation）
- 预期 ③：处理完后 goal 评审才跑一次 — 不再有 continuation 自动推（你的消息抢占了 goal loop）
- 预期 ④：你的消息处理完后 goal 仍 active（除非评审正好判 done）
- 失败信号：你的消息排在 continuation 后面 → 优先级倒了；goal pause 了 → 抢占检测错把你 pause 了

**10.3 收尾**
- `/goal clear`

---

## Phase 11 — Parse-Failure Auto-Pause（可选，故意配坏）

> **重要术语**：fail-open 本身**没有次数限制** — 每次 judge 出错（API 超时 / 网络挂 / 非 JSON 回复）都返回 `continue` 让 loop 继续，**永远兜底**。这里的阈值仅针对一种特定故障：**judge 调用成功但回复无法解析成 JSON**（`parseFailed=true`）连续 N 次。API/网络错（`parseFailed=false`）**不计数**。设计目的是：网络瞬断不该锁死 goal；只有"模型挺活但说不出 JSON"才说明配的 judge model 不对，这才打断让用户换 model。
>
> 默认阈值是 **10**（hermes 上游是 3，axiomate 放宽给 flaky 网络更多余量）。可在 `/config` 里改成 `3 / 5 / 10 / 20 / 50 / 0`（0 = 完全禁用 auto-pause，loop 只靠 turn budget 兜底）。

**11.1 把阈值临时调到 3 加速复现**
- `/config` → 找到 "Goal parse-failure auto-pause threshold" 改成 `3`
- 退出对话框（应看到 `Set goal parse-failure threshold to 3`）

**11.2 配一个会返回乱码的 judge**
- 在 `~/.axiomate.json` 加：
  ```json
  "midModel": "<某个 base completion model，例如 gpt-3.5-turbo-instruct>"
  ```
  （没有专门的"goal judge model"字段 — judge 直接走 axiomate 的 midModel → fastModel → currentModel 链）
- 退出重启 axiomate

**11.3 触发**
- `/goal 输出 hello`
- 等前 3 轮跑完

**11.4 预期**
- 第 3 轮末出现 `⏸ Goal paused — the judge model (3 turns) isn't returning the required JSON verdict. Set midModel or fastModel in ~/.axiomate.json to a stricter model (one that follows JSON output instructions). Then /goal resume to continue.`
- Footer pill 变黄
- 失败信号：到第 10 / 20 轮才停 → 阈值没读到 config override；从不停 → 计数器没在 increment

**11.5 恢复**
- `/config` 把阈值改回 `10`
- 把 `midModel` 改回正常 instruct 模型或删掉
- 重启

---

## Phase 12 — UI 一致性

**12.1 Continuation marker**
- 在任何 active goal 跑过的 session 里
- Scroll 到 transcript 中间的某条 ↻ 续作 prompt
- 预期 ①：它前面有 cyan ↻ 图标
- 预期 ②：与普通 user prompt 视觉上能区分
- 失败信号：续作 prompt 和你打的消息看起来一样 → UserGoalContinuationMessage 没注册

**12.2 verdict isMeta**
- 看 ↻ Continuing toward goal X/Y 那一行
- 切到 `/rewind` picker（如果可以）
- 预期：picker **不**显示这条 verdict 行（isMeta，不进 chain）
- 失败信号：picker 里能看到 verdict 行 → isMeta 没设上

---

## 跑完后总结表

| Phase | 验证什么 | LLM 调用数（估） |
|---|---|---|
| 1 | 命令解析 | 0 |
| 2 | 简单 happy path | 1 turn + 1 judge |
| 3 | 多轮 continuation | 3 turn + 3 judge |
| 4 | manual pause/resume | 3 turn + 3 judge |
| 5 | Ctrl+C pause | 1 turn |
| 6 | subgoal | 1-2 turn + 1-2 judge |
| 7 | cost warning | 0（不真跑 loop） |
| 8 | persistence/resume | 1-2 turn |
| 9 | fork 隔离 | 1 turn + 1 judge |
| 10 | 用户抢占 | 2-3 turn + 2-3 judge |
| 11 | parse failure（可选） | 3 turn + 3 bad judge |
| 12 | UI 一致性 | 0 |

总 LLM 成本：~15-20 main turn + 12-15 judge call。fastModel 配 Haiku 整套大约 ¥1-2。

---

## 已知细节 / 局限

- **pause 竞争窗口**：`/goal pause` 时如果 continuation 已经入队（罕见时序），下一轮还会跑一次后才真停。可接受。
- **resume 不自动 kick**：与 hermes 一致 — `/goal resume` 后需要任意 user input 才触发下一轮评审。
- **fork 不继承 goal**：fork 过滤器只带 transcript message，`goal-state` 条目被自动 skip — 这是有意行为。
- **续作 prompt 进 transcript**：是真实 user message，占 token、`/resume` 会带回。verdict 才 isMeta 不进 chain。
