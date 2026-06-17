import { randomUUID } from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Message, UserMessage } from '../../../../types/message.js'
import { createFileStateCacheWithSizeLimit } from '../../../../utils/fileStateCache.js'

const planFilePath = 'C:\\workspace\\.plans\\session-memory-plan.md'
// CRLF fixture (Windows plan) — the stored read-state content must be
// LF-normalized to match the Write/Edit gate. An LF-only fixture here would
// not catch a normalization regression on this injection path (blind spot B3,
// see docs/file/read-state-write-consolidation-plan.md).
const planContent = '# Plan\r\n\r\n- keep working\r\n'
const planContentNormalized = '# Plan\n\n- keep working\n'
const sessionMemoryContent = '# Current State\n\nContinue the task.'

vi.mock('../../../../utils/plans.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../../utils/plans.js')>()
  return {
    ...actual,
    getPlan: vi.fn(() => planContent),
    getPlanFilePath: vi.fn(() => planFilePath),
  }
})

vi.mock(
  '../../../../services/SessionMemory/prompts.js',
  async importOriginal => {
    const actual =
      await importOriginal<
        typeof import('../../../../services/SessionMemory/prompts.js')
      >()
    return {
      ...actual,
      isSessionMemoryEmpty: vi.fn(async () => false),
    }
  },
)

vi.mock(
  '../../../../services/SessionMemory/sessionMemoryUtils.js',
  async importOriginal => {
    const actual =
      await importOriginal<
        typeof import('../../../../services/SessionMemory/sessionMemoryUtils.js')
      >()
    return {
      ...actual,
      getLastSummarizedMessageId: vi.fn(() => undefined),
      getSessionMemoryContent: vi.fn(async () => sessionMemoryContent),
      waitForSessionMemoryExtraction: vi.fn(async () => {}),
    }
  },
)

vi.mock('../../../../utils/model/model.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../../utils/model/model.js')>()
  return {
    ...actual,
    getMainLoopModel: vi.fn(() => 'test-model'),
  }
})

vi.mock('../../../../utils/sessionStorage.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../../utils/sessionStorage.js')>()
  return {
    ...actual,
    getTranscriptPath: vi.fn(() => 'C:\\workspace\\transcript.jsonl'),
  }
})

vi.mock('../../../../utils/sessionStart.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../../utils/sessionStart.js')>()
  return {
    ...actual,
    processSessionStartHooks: vi.fn(async () => []),
  }
})

import { trySessionMemoryCompaction } from '../../../../services/compact/sessionMemoryCompact.js'

function makeUserMsg(text: string): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: text },
  } as unknown as UserMessage
}

function makeMinimalContext() {
  return {
    readFileState: createFileStateCacheWithSizeLimit(100, 1_000_000),
  }
}

describe('session-memory compact plan read state', () => {
  beforeEach(() => {
    process.env.ENABLE_AXIOMATE_CODE_SM_COMPACT = '1'
  })

  it('marks the injected plan attachment as observed read state', async () => {
    const messages: Message[] = [makeUserMsg('continue from memory')]
    const context = makeMinimalContext()

    const result = await trySessionMemoryCompaction(
      messages,
      undefined,
      undefined,
      context as never,
    )

    expect(result).not.toBeNull()
    expect(
      result!.attachments.some(
        attachment => attachment.attachment.type === 'plan_file_reference',
      ),
    ).toBe(true)
    expect(context.readFileState.get(planFilePath)?.content).toBe(
      planContentNormalized,
    )
    expect(context.readFileState.get(planFilePath)?.content).not.toContain('\r')
    expect(
      context.readFileState.get(planFilePath)?.registrySequence,
    ).toBeDefined()
  })
})
