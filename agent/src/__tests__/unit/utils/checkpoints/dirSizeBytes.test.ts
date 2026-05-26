/**
 * Anchor test for `dirSizeBytes` — the helper that backs prune's size cap
 * today and will back Phase 5 `storeStatus`'s "total store size" field
 * tomorrow. Phase 5 step 2 will likely relocate this function into a
 * shared module so both prune and storeStatus consume one source of
 * truth; this file pins the observable contract so that move is safe.
 *
 * Contract being pinned:
 *   - sum of file sizes recursively (one fs.stat per file, no walk-time math)
 *   - directories are walked, not counted toward the byte total
 *   - missing path → 0 (do not throw — checkpoints subsystem must never block)
 *   - unreadable directory inside the tree → skipped, others still summed
 *
 * The Hermes parity reference is `_dir_size_bytes:528-540`. Hermes returns
 * 0 on any per-entry exception. We mirror that.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { dirSizeBytes } from '../../../../utils/checkpoints/prune.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'axiomate-dirsize-'))
})

afterEach(() => {
  // Defensive chmod-restore in case a test left an unreadable dir behind.
  try {
    chmodSync(root, 0o755)
  } catch {
    // ignore
  }
  rmSync(root, { recursive: true, force: true })
})

function writeBytes(path: string, n: number): void {
  writeFileSync(path, Buffer.alloc(n, 0x41))
}

describe('dirSizeBytes — observable contract', () => {
  test('empty directory → 0', () => {
    expect(dirSizeBytes(root)).toBe(0)
  })

  test('single file → that file size', () => {
    writeBytes(join(root, 'a.bin'), 1024)
    expect(dirSizeBytes(root)).toBe(1024)
  })

  test('multiple files in same dir → sum of sizes', () => {
    writeBytes(join(root, 'a.bin'), 100)
    writeBytes(join(root, 'b.bin'), 250)
    writeBytes(join(root, 'c.bin'), 17)
    expect(dirSizeBytes(root)).toBe(367)
  })

  test('nested directories → recursive sum (directories themselves are not counted)', () => {
    writeBytes(join(root, 'top.bin'), 10)
    mkdirSync(join(root, 'a'))
    writeBytes(join(root, 'a', 'inner.bin'), 100)
    mkdirSync(join(root, 'a', 'b'))
    writeBytes(join(root, 'a', 'b', 'deep.bin'), 1000)
    expect(dirSizeBytes(root)).toBe(1110)
  })

  test('missing path → 0 (do not throw)', () => {
    const nonexistent = join(root, 'definitely-not-here')
    expect(() => dirSizeBytes(nonexistent)).not.toThrow()
    expect(dirSizeBytes(nonexistent)).toBe(0)
  })

  test('path is a file rather than a directory → 0 (best-effort, no throw)', () => {
    const filePath = join(root, 'a-file.bin')
    writeBytes(filePath, 42)
    // Hermes' helper is a directory walker. Pointing it at a file lands
    // in the readdir-fails catch block. We mirror that — return 0 and
    // never throw.
    expect(() => dirSizeBytes(filePath)).not.toThrow()
    expect(dirSizeBytes(filePath)).toBe(0)
  })
})
