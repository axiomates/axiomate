import { describe, expect, test, vi } from 'vitest'

import { ExitPlanModeV2Tool } from '../../../../tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../../../Tool.js'
import type { AppState } from '../../../../state/AppStateStore.js'

vi.mock('../../../../utils/plans.js', () => ({
  getPlan: () => 'Test plan',
  getPlanFilePath: () => 'C:/tmp/plan.md',
}))

vi.mock('../../../../utils/teammate.js', () => ({
  getAgentName: () => undefined,
  getTeamName: () => undefined,
  isPlanModeRequired: () => false,
  isTeammate: () => false,
}))

function makeContext(initialMode: 'plan' | 'bypassPermissions'): {
  context: ToolUseContext
  getState: () => AppState
} {
  let state = {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: initialMode,
      prePlanMode: 'bypassPermissions',
    },
  } as AppState

  return {
    context: {
      agentId: undefined,
      options: {
        tools: [],
      },
      getAppState: () => state,
      setAppState: (updater: (prev: AppState) => AppState) => {
        state = updater(state)
      },
    } as unknown as ToolUseContext,
    getState: () => state,
  }
}

describe('ExitPlanModeV2Tool', () => {
  test('inputSchema accepts the plan/planFilePath injected by normalizeToolInput', () => {
    // Regression: inputSchema must keep .passthrough() so the plan and
    // planFilePath that normalizeToolInput injects during stream accumulation
    // survive runToolUse's initial tool.inputSchema.safeParse. A bare
    // strictObject rejects them ("An unexpected parameter `plan`") and blocks
    // every plan approval before the permission dialog even appears.
    expect(
      ExitPlanModeV2Tool.inputSchema.safeParse({
        plan: 'Test plan',
        planFilePath: 'C:/tmp/plan.md',
      }).success,
    ).toBe(true)
  })

  test('accepts approved exit mode from permission-updated input', () => {
    expect(
      ExitPlanModeV2Tool.permissionUpdatedInputSchema?.safeParse({
        _approvedExitMode: 'bypassPermissions',
      }).success,
    ).toBe(true)
  })

  test('applies the approved exit mode after successful plan approval', async () => {
    const { context, getState } = makeContext('plan')

    await ExitPlanModeV2Tool.call(
      { _approvedExitMode: 'default' } as never,
      context,
      async () => ({ behavior: 'allow' }),
      {} as never,
    )

    expect(getState().toolPermissionContext.mode).toBe('default')
    expect(getState().toolPermissionContext.prePlanMode).toBeUndefined()
  })

  test('keeps an already-applied mode when no approved exit mode is provided', async () => {
    const { context, getState } = makeContext('bypassPermissions')

    await ExitPlanModeV2Tool.call(
      {},
      context,
      async () => ({ behavior: 'allow' }),
      {} as never,
    )

    expect(getState().toolPermissionContext.mode).toBe('bypassPermissions')
    expect(getState().toolPermissionContext.prePlanMode).toBeUndefined()
  })

  // Regression guard for the "You are not in plan mode" error on plan approval.
  // validateInput rejects once mode has left 'plan'. The keep-context dialog
  // path passes empty permissionUpdates (so mode is still 'plan' here) and a
  // setMode path leaves 'plan' before the approved input is re-validated — which
  // is exactly why toolExecution.ts skips re-running this validateInput on the
  // permission source. These two tests pin both halves of that contract.
  test('validateInput rejects when mode has already left plan', async () => {
    const { context } = makeContext('bypassPermissions')

    const result = await ExitPlanModeV2Tool.validateInput?.(
      {} as never,
      context as never,
    )

    expect(result?.result).toBe(false)
    expect(result?.result === false && result.message).toContain(
      'not in plan mode',
    )
  })

  test('validateInput passes while mode is still plan', async () => {
    const { context } = makeContext('plan')

    const result = await ExitPlanModeV2Tool.validateInput?.(
      {} as never,
      context as never,
    )

    expect(result?.result).toBe(true)
  })
})
