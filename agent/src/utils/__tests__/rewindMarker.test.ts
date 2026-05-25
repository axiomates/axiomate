import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, test, beforeEach, afterEach } from 'vitest'

import { randomUUID, type UUID } from 'crypto'
import type { ConversationRewindMarker, ConversationHeadEntry } from '../../types/logs.js'
import { loadTranscriptFile } from '../sessionStorage.js'

/**
 * Reader-side coverage for the rewind-marker JSONL entry.
 *
 * We don't drive the live recordRewindMarker here because the writer
 * pulls its target path off getTranscriptPathForSession (which itself
 * funnels through getProjectDir/getOriginalCwd); mocking that path
 * pulls in the whole settings-loading dependency chain. Instead we
 * write JSONL bytes directly and assert loadTranscriptFile picks them
 * up. The shape here is the same shape the writer produces, so any
 * drift in the writer's output would still surface as a test break
 * (shape comes from logs.ts ConversationRewindMarker, single source).
 */
describe('loadTranscriptFile rewind-marker support', () => {
  let dir: string
  let sessionId: UUID
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'axiomate-rewind-loader-'))
    sessionId = randomUUID()
    path = join(dir, `${sessionId}.jsonl`)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeEntries(entries: object[]): void {
    writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  }

  function makeMarker(overrides: Partial<ConversationRewindMarker>): ConversationRewindMarker {
    return {
      type: 'rewind-marker',
      uuid: randomUUID(),
      fromLeafUuid: randomUUID(),
      toLeafUuid: randomUUID(),
      abandonedCount: 1,
      timestamp: new Date().toISOString(),
      sessionId,
      ...overrides,
    }
  }

  function makeHead(overrides: Partial<ConversationHeadEntry>): ConversationHeadEntry {
    return {
      type: 'head',
      uuid: randomUUID(),
      headUuid: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId,
      ...overrides,
    }
  }

  test('absent → undefined', async () => {
    writeEntries([])
    const loaded = await loadTranscriptFile(path)
    expect(loaded.latestRewindMarker).toBeUndefined()
  })

  test('single marker → returned as latestRewindMarker', async () => {
    const marker = makeMarker({
      abandonedCount: 4,
      timestamp: '2026-05-25T10:00:00.000Z',
    })
    writeEntries([marker])
    const loaded = await loadTranscriptFile(path)
    expect(loaded.latestRewindMarker?.uuid).toBe(marker.uuid)
    expect(loaded.latestRewindMarker?.abandonedCount).toBe(4)
  })

  test('latest-timestamp wins across multiple markers', async () => {
    const older = makeMarker({
      timestamp: '2026-05-25T10:00:00.000Z',
      abandonedCount: 1,
    })
    const newer = makeMarker({
      timestamp: '2026-05-25T11:00:00.000Z',
      abandonedCount: 9,
    })
    // Write older first, newer second — order on disk shouldn't matter
    // for resolution; timestamp does.
    writeEntries([older, newer])
    const loaded = await loadTranscriptFile(path)
    expect(loaded.latestRewindMarker?.uuid).toBe(newer.uuid)
    expect(loaded.latestRewindMarker?.abandonedCount).toBe(9)
  })

  test('head record and marker coexist independently', async () => {
    const head = makeHead({ timestamp: '2026-05-25T10:00:00.000Z' })
    const marker = makeMarker({
      toLeafUuid: head.headUuid,
      timestamp: '2026-05-25T10:00:00.000Z',
    })
    writeEntries([head, marker])
    const loaded = await loadTranscriptFile(path)
    expect(loaded.conversationHead?.headUuid).toBe(head.headUuid)
    expect(loaded.latestRewindMarker?.toLeafUuid).toBe(head.headUuid)
  })

  test('malformed marker (missing toLeafUuid) is skipped', async () => {
    const broken = {
      type: 'rewind-marker',
      uuid: randomUUID(),
      fromLeafUuid: randomUUID(),
      // toLeafUuid omitted on purpose — reader's truthy guard skips it.
      abandonedCount: 1,
      timestamp: '2026-05-25T10:00:00.000Z',
      sessionId,
    }
    writeEntries([broken])
    const loaded = await loadTranscriptFile(path)
    expect(loaded.latestRewindMarker).toBeUndefined()
  })
})
