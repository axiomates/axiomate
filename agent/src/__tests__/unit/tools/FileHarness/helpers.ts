import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import {
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from '../../../../Tool.js'
import {
  createFileStateCacheWithSizeLimit,
  type FileStateCache,
} from '../../../../utils/fileStateCache.js'

const harnessState = vi.hoisted(() => ({
  tempDir: '',
  cwd: '',
  testCounter: 0,
}))

export function getHarnessCwd(): string {
  return harnessState.cwd
}

export function mockFileHarnessRuntime(): void {
  vi.doMock('../../../../bootstrap/state.js', () => ({
    addSlowOperation: vi.fn(),
    getActiveTimeCounter: () => null,
    getAdditionalDirectoriesForAxiomateMd: () => [],
    getAllowedSettingSources: () => [],
    getCacheEditingHeaderLatched: () => null,
    getCwdState: () => harnessState.cwd,
    getEventLogger: () => null,
    getFlagSettingsInline: () => null,
    getFlagSettingsPath: () => undefined,
    getIsInteractive: () => false,
    getIsNonInteractiveSession: () => true,
    getOriginalCwd: () => harnessState.cwd,
    getProjectRoot: () => harnessState.cwd,
    getPromptCache1hAllowlist: () => null,
    getPromptCache1hEligible: () => null,
    getPromptId: () => null,
    getSessionId: () => 'file-harness-session',
    getSessionProjectDir: () => null,
    getUseHostPlugins: () => false,
    hasExitedPlanModeInSession: () => false,
    preferThirdPartyAuthentication: () => true,
    setCacheEditingHeaderLatched: vi.fn(),
    setLastAPIRequest: vi.fn(),
    setLastAPIRequestMessages: vi.fn(),
    setPromptCache1hAllowlist: vi.fn(),
    setPromptCache1hEligible: vi.fn(),
  }))

  vi.doMock('../../../../skills/loadSkillsDir.js', () => ({
    activateConditionalSkillsForPaths: vi.fn(),
    addSkillDirectories: vi.fn(),
    discoverSkillDirsForPaths: vi.fn(async () => []),
  }))

  vi.doMock('../../../../services/lsp/manager.js', () => ({
    getLspServerManager: () => undefined,
  }))

  vi.doMock('../../../../services/lsp/LSPDiagnosticRegistry.js', () => ({
    clearDeliveredDiagnosticsForFile: vi.fn(),
  }))

  vi.doMock('../../../../services/diagnosticTracking.js', () => ({
    diagnosticTracker: {
      beforeFileEdited: vi.fn(async () => {}),
    },
  }))

  vi.doMock('../../../../utils/permissions/filesystem.js', () => ({
    checkReadPermissionForTool: vi.fn((_, input) => ({
      behavior: 'allow',
      updatedInput: input,
    })),
    checkWritePermissionForTool: vi.fn((_, input) => ({
      behavior: 'allow',
      updatedInput: input,
    })),
    matchingRuleForInput: vi.fn(() => null),
  }))

  vi.doMock('../../../../utils/settings/validateEditTool.js', () => ({
    validateInputForSettingsFileEdit: vi.fn(() => null),
  }))

  vi.doMock('../../../../utils/diff.js', () => ({
    CONTEXT_LINES: 3,
    countLinesChanged: vi.fn(),
    getPatchForDisplay: vi.fn(() => []),
    getPatchFromContents: vi.fn(() => []),
  }))

  vi.doMock('../../../../utils/messages.js', () => ({
    createUserMessage: vi.fn(
      ({ content, isMeta }: { content: unknown; isMeta?: true }) => ({
        type: 'user',
        message: {
          role: 'user',
          content,
        },
        isMeta,
        uuid: 'file-harness-user-message',
        timestamp: new Date(0).toISOString(),
      }),
    ),
  }))

  const toolUiMock = {
    getToolUseSummary: () => null,
    isResultTruncated: () => false,
    renderToolResultMessage: () => null,
    renderToolUseErrorMessage: () => null,
    renderToolUseMessage: () => null,
    renderToolUseRejectedMessage: () => null,
    renderToolUseTag: () => null,
    userFacingName: () => 'File',
  }

  vi.doMock('../../../../tools/FileReadTool/UI.js', () => toolUiMock)
  vi.doMock('../../../../tools/FileEditTool/UI.js', () => toolUiMock)
  vi.doMock('../../../../tools/FileWriteTool/UI.js', () => toolUiMock)
}

export function setupFileHarness(): void {
  beforeEach(async () => {
    harnessState.testCounter++
    harnessState.tempDir = await mkdtemp(
      join(tmpdir(), 'axiomate-file-harness-'),
    )
    harnessState.cwd = join(
      harnessState.tempDir,
      `workspace-${harnessState.testCounter}`,
    )
    await mkdir(harnessState.cwd, { recursive: true })
    vi.clearAllMocks()
  })

  afterEach(async () => {
    if (harnessState.tempDir) {
      await rm(harnessState.tempDir, { recursive: true, force: true })
    }
    harnessState.tempDir = ''
    harnessState.cwd = ''
  })
}

export function makeReadFileState(): FileStateCache {
  return createFileStateCacheWithSizeLimit(100, 2_000_000)
}

export function makeToolContext(
  overrides: Partial<ToolUseContext> = {},
): ToolUseContext {
  const readFileState = overrides.readFileState ?? makeReadFileState()
  const baseContext = {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'test-model',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: {
        activeAgents: [],
        allAgents: [],
      },
    },
    abortController: new AbortController(),
    readFileState,
    getAppState: () =>
      ({
        toolPermissionContext: getEmptyToolPermissionContext(),
      }) as any,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
    nestedMemoryAttachmentTriggers: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
  } as ToolUseContext

  return {
    ...baseContext,
    ...overrides,
    readFileState,
  } as ToolUseContext
}

export const allowToolUse = (async () => ({
  behavior: 'allow' as const,
})) as any

export const parentMessage = { message: { id: 'assistant-message' } } as any
