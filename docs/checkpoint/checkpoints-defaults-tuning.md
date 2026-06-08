# Checkpoint 默认配置调整指南

## 何时读这份

需要改 Axiomate checkpoints / picker 子系统默认行为常量时，按这份清单同步
源码、CLI 帮助、Settings UI、ConfigTool schema、用户文档和测试。

这份文档只描述当前实现。旧 phase 文档、旧迁移记录和外部项目对比不是当前
行为依据；当前设计以 `docs/checkpoint/checkpoints-design.md` 为准。

## 必须同步的用户文档

任何常量或行为说明变更，都必须同步：

- `docs/checkpoint/checkpoints-design.md`
- `docs/user/checkpoints_zhcn.html`

如果变更涉及已知风险或未定设计，还要同步：

- `docs/checkpoint/checkpoints-review-findings.md`
- `docs/checkpoint/checkpoints-open-questions.md`
- `docs/checkpoint/checkpoints-test-plan.md`

不要留下与当前事实不符的旧文档。历史记录交给 git history。

## 七个相关常量

### 1. `ROWS_FALLBACK`

用途：`/checkpoints status` 和 `/checkpoints list` 默认显示行数。

主源：

- `agent/src/commands/checkpoints/resolveStatusRows.ts`

跟随位置：

- 同文件 JSDoc
- `agent/src/utils/config.ts` 的 `checkpointsStatusRows`
- `agent/src/main.tsx` 的 `checkpoints status --rows` 和
  `checkpoints list --rows` 描述
- `agent/src/components/Settings/Config.tsx`
- `agent/src/tools/ConfigTool/supportedSettings.ts`
- `docs/user/checkpoints_zhcn.html`
- `agent/src/__tests__/unit/commands/checkpoints/resolveStatusRows.test.ts`

### 2. `ROWS_MAX`

用途：`--rows` 和 config 中 checkpoint 行数的最大值。

主源：

- `agent/src/commands/checkpoints/resolveStatusRows.ts`

跟随位置：

- 同文件 JSDoc
- `agent/src/main.tsx` 的 `--rows` 描述
- `agent/src/tools/ConfigTool/supportedSettings.ts`
- `docs/user/checkpoints_zhcn.html`
- 边界测试中硬编码的最大值

### 3. `DEFAULT_RETENTION_DAYS`

用途：stale prune 的默认保留天数。

主源：

- `agent/src/utils/checkpoints/prune.ts`

跟随位置：

- 同文件 JSDoc 和 `PruneOptions.retentionDays`
- `agent/src/main.tsx` 的 `checkpoints prune --retention-days` 描述
- `docs/user/checkpoints_zhcn.html`
- 测默认值的单测

显式传 `retentionDays` 的测试通常不需要改；它们测试的是传入值行为。

### 4. `DEFAULT_MAX_TOTAL_SIZE_MB`

用途：checkpoint store 默认总大小上限。

主源：

- `agent/src/utils/checkpoints/prune.ts`

跟随位置：

- 同文件 JSDoc 和 `PruneOptions.maxTotalSizeMb`
- `agent/src/main.tsx` 的 `checkpoints prune --max-size-mb` 描述
- `docs/user/checkpoints_zhcn.html`

### 5. `MAX_SNAPSHOTS`

用途：每个项目 ref 的快照数量上限 fallback。

主源：

- `agent/src/utils/checkpoints/createSnapshot.ts`

用户配置入口：

- global config `checkpointsMaxSnapshotsPerProject`

跟随位置：

- `agent/src/utils/checkpoints/createSnapshot.ts` 注释
- `agent/src/utils/checkpoints/prune.ts` 的
  `DEFAULT_MAX_SNAPSHOTS_PER_REF`
- `agent/src/utils/config.ts`
- `agent/src/components/Settings/Config.tsx`
- `agent/src/tools/ConfigTool/supportedSettings.ts`
- `agent/src/commands/checkpoints/views.ts`
- `docs/user/checkpoints_zhcn.html`
- prune snapshot-cap 相关单测

`0` 表示禁用 per-project snapshot cap。

### 6. `MAX_FILES`

用途：单次 checkpoint snapshot 的工作目录文件数上限 fallback。

主源：

- `agent/src/utils/checkpoints/createSnapshot.ts`

用户配置入口：

- global config `checkpointsMaxFiles`

运行时语义：

- `0` 表示不限制。
- 正数会被 clamp 到 `MAX_FILES_CONFIG_LIMIT`。
- 当前进程内会缓存 `too-many-files` 结果，避免重复扫描超大目录。

跟随位置：

- `agent/src/utils/checkpoints/createSnapshot.ts`
- `agent/src/utils/config.ts`
- `agent/src/components/Settings/Config.tsx`
- `agent/src/tools/ConfigTool/supportedSettings.ts`
- `docs/user/checkpoints_zhcn.html`
- `createSnapshot.test.ts` 的 max-files 覆盖

注意：`agent/src/utils/gitDiff.ts` 里的同名 `MAX_FILES` 是 diff 展示限制，
不是 checkpoint 工作目录文件数限制。

### 7. `MAX_FILE_SIZE_MB`

用途：单文件进入 checkpoint managed tree 的大小上限。

主源：

- `agent/src/utils/checkpoints/createSnapshot.ts`

跟随位置：

- 同文件传参和注释
- `docs/user/checkpoints_zhcn.html`
- oversize 文件相关测试

## 行为语义不能混

`/checkpoints list` 与 `/rewind` 的 `+x -y` 语义不同：

- `/checkpoints list`：commit 自身修改，`parent(commit) -> commit`
- `/rewind` file tab：选择该行的 rewind 后果
  - older row：`checkpoint -> next checkpoint`
  - newest row：`checkpoint -> current disk`

修改 stats 相关代码或文档时，必须同时检查这两个界面，不能把一个界面的
helper 直接拿给另一个界面用。

## 实战 checklist

1. 确定新值和用户语义。
2. 改主源常量。
3. 改 CLI option description。
4. 改 Settings UI。
5. 改 ConfigTool schema。
6. 改 `docs/user/checkpoints_zhcn.html`。
7. 改 `docs/checkpoint/checkpoints-design.md` 中受影响的行为描述。
8. 如涉及未定设计，更新 open questions 或 review findings。
9. 跑验证：

```text
pnpm --filter ./agent run build:types
pnpm --filter ./agent exec vitest run src/__tests__/unit/commands/checkpoints/resolveStatusRows.test.ts
pnpm --filter ./agent exec vitest run src/__tests__/unit/utils/checkpoints/prune.test.ts
```

按实际改动补跑 createSnapshot、fileHistory、worktreeReconcile、checkpoint CLI
e2e。

## 搜索验收

文档更新后至少跑：

```text
rg -n "git add -A|parent\\(commit\\)|/checkpoints list|/rewind" docs/checkpoint docs/user/checkpoints_zhcn.html
rg --files docs/checkpoint
```

允许出现的敏感词必须有当前上下文，例如 `git add -A` 只能出现在“生产不用，
测试 oracle 可用”的描述里。`rg --files docs/checkpoint` 不应列出旧 phase /
progress / audit 文档。
