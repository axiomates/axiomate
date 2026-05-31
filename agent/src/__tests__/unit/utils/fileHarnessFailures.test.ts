import { describe, expect, test } from 'vitest'
import {
  FILE_HARNESS_FAILURE_CATALOG,
  FILE_HARNESS_FAILURE_REASONS,
  getFileHarnessFailureCatalogEntry,
} from '../../../utils/fileHarnessFailures.js'

describe('file harness failure taxonomy', () => {
  test('has one catalog entry for every reason', () => {
    expect(FILE_HARNESS_FAILURE_CATALOG.map(entry => entry.reason)).toEqual(
      FILE_HARNESS_FAILURE_REASONS,
    )
  })

  test('does not define duplicate failure reasons', () => {
    const reasons = FILE_HARNESS_FAILURE_CATALOG.map(entry => entry.reason)
    expect(new Set(reasons).size).toBe(reasons.length)
  })

  test('documents current signals and Stage 6B actions for every reason', () => {
    for (const entry of FILE_HARNESS_FAILURE_CATALOG) {
      expect(entry.description.length).toBeGreaterThan(20)
      expect(entry.phases.length).toBeGreaterThan(0)
      expect(entry.currentSignals.length).toBeGreaterThan(0)
      expect(entry.stage6bAction.length).toBeGreaterThan(20)
    }
  })

  test('keeps encoding unsupported as the only planned reason in Stage 6A', () => {
    const planned = FILE_HARNESS_FAILURE_CATALOG.filter(
      entry => entry.disposition === 'planned',
    ).map(entry => entry.reason)

    expect(planned).toEqual(['encoding_unsupported'])
  })

  test('looks up catalog entries by reason', () => {
    expect(getFileHarnessFailureCatalogEntry('atomic_write_failed').reason).toBe(
      'atomic_write_failed',
    )
    expect(
      getFileHarnessFailureCatalogEntry('sibling_write_after_read')
        .currentSignals,
    ).toContain('wasFileModifiedAfterReadByAnotherContext returns true')
  })
})
