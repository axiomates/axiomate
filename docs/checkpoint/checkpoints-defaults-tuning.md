# Checkpoint 默认配置调整指南

## 何时读这份

需要改 axiomate checkpoints / picker 子系统的默认行为常量时。这份不是
"应该怎么设"——它是**清单**：每个常量的所有触达点（源码、CLI option
description、Settings UI、用户 doc、单测期望），改一个常量需要同步
更新哪些地方。

按这份操作能避免典型遗漏：改了源码常量但 CLI `--help` 描述还说旧默认值、
Settings 选项循环里还有旧值、user doc 还说"默认 50"等。

## 七个相关常量 + 触达清单

每个常量都给出"主源 + 跟随位置"。改主源时，按列表逐一更新跟随位置。

### 1. `ROWS_FALLBACK` — `/checkpoints status` / `list` 默认行数

**主源**：`agent/src/commands/checkpoints/resolveStatusRows.ts:21` —— `export const ROWS_FALLBACK = ...`

**跟随**：

- 同文件顶部 JSDoc 里的"Hard-coded fallback `N`"措辞
- `agent/src/utils/config.ts` 里 `getDefaults()` 的 `checkpointsStatusRows: N`
  （`globalConfig` 默认值，跟 ROWS_FALLBACK 必须一致）
- `agent/src/main.tsx` 里 `checkpoints status` / `list` 子命令的
  `--rows` option description 文本（"default: globalConfig.checkpointsStatusRows = N"）
- `agent/src/components/Settings/Config.tsx` 的 `checkpointsStatusRows`
  enum option 列表 —— 选项里要有这个新默认值，且首项接近最常用尺寸
- `docs/user/checkpoints_zhcn.html`：搜"默认 50"或当前默认数；
  搜"50 行"；commands 子命令表格描述；`/checkpoints status` /
  `list` 子节描述；FAQ
- 单测 `agent/src/__tests__/unit/commands/checkpoints/resolveStatusRows.test.ts`
  里硬编码 `30` 的断言（如果有）

### 2. `ROWS_MAX` — 上限 clamp

**主源**：`agent/src/commands/checkpoints/resolveStatusRows.ts:20` ——
`export const ROWS_MAX = ...`

**跟随**：

- 同文件 JSDoc "Returns a finite integer in `[1, N]`"
- `agent/src/main.tsx` `--rows` description 里的 "Range 1..N"
- `agent/src/tools/ConfigTool/supportedSettings.ts` 的
  `checkpointsStatusRows` 条目：`max: N` + description 里的 "Range 1..N"
- `docs/user/checkpoints_zhcn.html`：所有"1..500"或当前上限
- 单测里硬编码 `500` 的边界测试

### 3. `DEFAULT_RETENTION_DAYS` — stale prune 阈值（天）

**主源**：`agent/src/utils/checkpoints/prune.ts:81` —— `export const DEFAULT_RETENTION_DAYS = ...`

**跟随**：

- 同文件上方 JSDoc 解释（注意重写理由——为什么这个值是合理的）
- 同文件 `PruneOptions.retentionDays` 字段的 `/** Override default
  N-day retention */` JSDoc
- `agent/src/main.tsx` `prune --retention-days` option description
  里的 "default N"
- `docs/user/checkpoints_zhcn.html`：自动清理表格"过期（stale）"项；
  Prune 阈值表格"保留天数"项；FAQ "/rewind 报错说 commit 找不到"段；
  CLI 示例命令里的具体数字
- 单测里**显式传值的 14 不算**——它们测的是显式 override 行为，不是
  默认值。但如果有测"不传时默认 14"的，要改

### 4. `DEFAULT_MAX_TOTAL_SIZE_MB` — 总大小上限（MB）

**主源**：`agent/src/utils/checkpoints/prune.ts:88`

**跟随**：

- 同文件 JSDoc + `PruneOptions.maxTotalSizeMb` JSDoc
- `agent/src/main.tsx` `prune --max-size-mb` description "default N"
- `docs/user/checkpoints_zhcn.html`：自动清理列表"超容量"项；Prune
  阈值表格；FAQ "占多少磁盘"段（单位换算 MB → GB 自然）；CLI 示例

### 5. `MAX_SNAPSHOTS` — 每项目快照 ring buffer 上限

**主源**：`agent/src/utils/checkpoints/createSnapshot.ts:69` ——
write-time 兜底默认值（globalConfig 未设时使用）。

**用户可配置入口**：globalConfig `checkpointsMaxSnapshotsPerProject`，
通过 `/config` TUI 调整。createSnapshot 写时和 prune 时都会读这个 config。
设置 `0` 禁用整个 cap（write-time + prune-time 同时禁用）。

**跟随**：

- `agent/src/utils/checkpoints/createSnapshot.ts` 的 step 12 注释
  （提及读 config 与 fallback）
- `agent/src/utils/checkpoints/prune.ts`
  - `DEFAULT_MAX_SNAPSHOTS_PER_REF` 常量（必须跟 createSnapshot 的
    MAX_SNAPSHOTS 同值，文档化"两者同源"）
  - `runSnapshotCapPass` 实现
  - PruneOptions.maxSnapshotsPerRef 字段（仅测试用）
- `agent/src/utils/config.ts`：
  - `GlobalConfig.checkpointsMaxSnapshotsPerProject` 类型字段
  - `getDefaults()` 默认值（必须 = MAX_SNAPSHOTS）
  - `EDITABLE_CONFIG_KEYS` 列表
- `agent/src/components/Settings/Config.tsx` 的 `checkpointsMaxSnapshotsPerProject`
  enum option 列表 —— 跟 `checkpointsStatusRows` 同形循环菜单
- `agent/src/tools/ConfigTool/supportedSettings.ts` 的
  `checkpointsMaxSnapshotsPerProject` schema (min/max/description)
- `agent/src/commands/checkpoints/views.ts` `renderPruneReport` 显示
  `Snap-cap refs touched / commits drop`（仅 N>0 才显示）
- `docs/user/checkpoints_zhcn.html` Prune 阈值表格"每个项目最多快照数"项
- 单测 `agent/src/__tests__/unit/utils/checkpoints/prune.test.ts` 的
  "snapshot cap pass" describe（小轮数 N=2/N=10/N=0/multi-ref）

### 6. `MAX_FILES` — 单次快照文件数上限

**主源**：`agent/src/utils/checkpoints/createSnapshot.ts:67` ——
fallback 默认值（globalConfig 未设时使用）。

**用户可配置入口**：globalConfig `checkpointsMaxFiles`，通过 `/config`
TUI 调整。createSnapshot 写快照前读取这个 config；设置 `0` 禁用文件数
guard。
配置范围是 `0..1,000,000`；为了兼容旧配置或手写 `~/.axiomate.json`，运行时会
把超过 `1,000,000` 的正数压到 `MAX_FILES_CONFIG_LIMIT = 1,000,000`，但 `0`
仍然保留为"不限制"。

**跟随**：

- 同文件 step 5 注释（提及读 config、fallback 与 `0` 禁用）
- 同文件错误消息字符串 `` `... too many files (>${maxFiles}) ...` ``
  —— 使用解析后的有效值，不是 hard-coded 数字
- `agent/src/utils/config.ts`：
  - `GlobalConfig.checkpointsMaxFiles` 类型字段
  - `getDefaults()` 默认值（必须 = MAX_FILES）
  - `GLOBAL_CONFIG_KEYS` 列表
- `agent/src/utils/checkpoints/createSnapshot.ts`：
  - `MAX_FILES_CONFIG_LIMIT` 上限（当前 1,000,000）
  - `normalizeConfiguredMaxFiles()` 对旧的大值做 clamp，并保留 `0` 禁用语义
- `agent/src/components/Settings/Config.tsx` 的 `checkpointsMaxFiles`
  enum option 列表 —— 跟 `checkpointsMaxSnapshotsPerProject` 同形循环菜单
- `agent/src/tools/ConfigTool/supportedSettings.ts` 的
  `checkpointsMaxFiles` schema (min/max/description)
- `docs/user/checkpoints_zhcn.html`：默认值卡片；自动跳过表格；用户配置表；
  Prune 阈值表格里的"单次快照最多工作目录文件数"；失败模式表格
- 单测 `agent/src/__tests__/unit/utils/checkpoints/createSnapshot.test.ts`
  的 `checkpointsMaxFiles` skip-with-touch 覆盖

注意 `agent/src/utils/gitDiff.ts` 里有一个**同名但语义不同**的
`const MAX_FILES = 50` —— 它是 diff 单次解析的文件数上限，不是
checkpoint 的工作目录文件数上限。**别动它**。

### 7. `MAX_FILE_SIZE_MB` — 单文件大小上限（MB）

**主源**：`agent/src/utils/checkpoints/createSnapshot.ts:68`

**跟随**：

- 同文件传给 git 的 `maxFileSizeMb` 参数（用常量，不是 hard-coded）
- `docs/user/checkpoints_zhcn.html`：自动跳过表格"单个文件大于 10 MB"项

## 实战 checklist

调整常量时按顺序跑：

1. **先确定新值**：跟用户对齐每个常量的目标值。注意常量之间的关联——
   - `MAX_SNAPSHOTS` × `DEFAULT_MAX_TOTAL_SIZE_MB`：snap 数 × 每 snap 大小
     不该长期超 size cap，否则 size pass 一直在删。1000 snap × 1MB ≈ 1GB
     是当前产品化默认的平衡点
   - `ROWS_FALLBACK` ≤ `MAX_SNAPSHOTS`：list 默认显示的行数不超过实际能
     存的 snap 数，否则 fallback 是噪音
   - `DEFAULT_RETENTION_DAYS` × turn 频率 × `MAX_SNAPSHOTS`：retention
     窗口里能塞下的 snap 数应该 ≤ MAX_SNAPSHOTS，否则 ring buffer
     先于 stale 触发，retention 实质失效

2. **改源码常量**：上面 7 个主源每个改一处

3. **改 CLI option description**：`agent/src/main.tsx` 三处子命令

4. **改 Settings UI**：`agent/src/components/Settings/Config.tsx` 的
   enum option 列表（适用于 ROWS 和 MAX_SNAPSHOTS）

5. **改 ConfigTool schema**：`agent/src/tools/ConfigTool/supportedSettings.ts`
   的 `min` / `max` / `description`（适用于 ROWS 和 MAX_SNAPSHOTS）

6. **改 user doc**：`docs/user/checkpoints_zhcn.html` —— 搜旧数字
   `grep -n '<old-number>' docs/user/checkpoints_zhcn.html`，全部位置
   逐一更新。footer 日期也更新到改动当天

7. **跑验证**：

   ```
   pnpm exec tsc --noEmit
   pnpm exec vitest run src/__tests__/unit/commands/checkpoints/resolveStatusRows.test.ts
   pnpm exec vitest run src/__tests__/unit/utils/checkpoints/prune.test.ts
   ```

   需要全过。如果单测里有测**默认值**的断言（不是显式传值），新值
   会让它失败 —— 改测试期望，不要回退源码

## 已知陷阱

### "测试硬编码默认值" vs "测试显式传值"

`prune.test.ts`、`prune.keepOrphans.test.ts`、`prune.keepRefs.test.ts`
里的 `retentionDays: 14` 大部分是**显式传值给被测函数**，不是测默认。
搜 `pruneCheckpoints({ ... retentionDays: 14 ... })` 这种形式 → **保留**
（测的是 retentionDays=14 时的行为，跟默认值无关）。

只有**不传 retentionDays 然后断言效果像 retention=14**这种才需要改。
当前 codebase 里没这种测试。

### Settings UI enum 选项首位置

`Config.tsx` 的 enum option 列表是**循环按选**的——按 Settings 里的
那一项会循环到下一个。把新默认值放进列表很重要，但**不需要放第一位**：
首位是用户首次按时跳到的值，不是默认初始值（那个由 `globalConfig` 决定）。

### `docs/user/checkpoints_zhcn.html` 里的 `100`

这个文件有几处 `100` 跟 MAX_SNAPSHOTS 没关系：

- `Snapshot metrics (last 100)` —— metrics rolling window，是另一个常量
- `100-300 MB` —— FAQ 估算磁盘占用，跟 size cap 关联但不是常量值

改 MAX_SNAPSHOTS 时不要扫式替换 `100`，要按 context 看。

### 常量注释里的 "Hermes 7d" 类对比

`prune.ts` 里 `DEFAULT_RETENTION_DAYS` 的旧注释提到"deliberate
divergence from Hermes' 7d"。改这个常量时要决定：是**继续跟 Hermes
对比**还是**只讲 axiomate 自己的理由**。dogfood 数据多了之后倾向后者
（axiomate 不该永远把 Hermes 当锚点）。
