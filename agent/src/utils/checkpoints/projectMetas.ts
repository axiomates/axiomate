/**
 * Read every `projects/<hash16>.json` from the shadow store. Used by
 * Phase 4 prune (orphan/stale passes) and Phase 5 storeStatus (project
 * count + per-project metadata in `/checkpoints status`).
 *
 * Single source of truth: the file shape was previously read by both
 * `prune.ts` and `storeStatus.ts`; consolidating here keeps the
 * field-validation rules (`workdir: string`, `created_at: number`,
 * `last_touch: number`) in one place. Mirrors Hermes `_list_projects`
 * (`tools/checkpoint_manager.py::_list_projects`); both Hermes call sites
 * (orphan-prune and store-status) walk this directory the same way.
 *
 * Never throws: corrupt files and unreadable directories surface as
 * entries on `errors` and are skipped. Caller chooses whether to surface
 * those errors (prune pushes them into PruneReport.errors; storeStatus
 * doesn't surface them — `/checkpoints status` is best-effort summary,
 * not a diagnostic).
 */

import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { getStoreDir } from './paths.js'

/**
 * Per-project metadata as it lives on disk.
 *
 * Field shape is the contract Phase 2 `touchProject.ts` writes. Any
 * change here must update `touchProject.ts` and the metadata schema
 * docs in `paths.ts:9` simultaneously.
 */
export interface ProjectMeta {
  /** 16-hex-char SHA prefix of the canonical workdir path. */
  hash: string
  /** Canonical absolute workdir path at last touch. */
  workdir: string
  /** Epoch seconds when this project was first registered. */
  created_at: number
  /** Epoch seconds at the most recent snapshot/touch. */
  last_touch: number
}

export interface LoadProjectMetasResult {
  metas: ProjectMeta[]
  errors: string[]
}

/**
 * Read all valid `projects/<hash16>.json` files in the store.
 *
 * - Missing `projects/` dir is not an error (no snapshots ever taken).
 * - Files whose name doesn't match `<16-hex>.json` are skipped silently
 *   (defensive — Phase 2 only writes 16-hex names, but a user dropping
 *   files in the dir shouldn't break the walk).
 * - Files whose JSON parses but fails the field-shape check land in
 *   `errors[]` as `malformed meta: <name>` and are dropped.
 * - Files whose JSON fails to parse or read land in `errors[]` with
 *   the underlying error message and are dropped.
 */
export async function loadProjectMetas(): Promise<LoadProjectMetasResult> {
  const projectsDir = join(getStoreDir(), 'projects')
  const errors: string[] = []
  let entries: string[]
  try {
    entries = await readdir(projectsDir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      errors.push(`readdir projects: ${(err as Error).message}`)
    }
    return { metas: [], errors }
  }

  const metas: ProjectMeta[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const hash = entry.slice(0, -'.json'.length)
    if (hash.length !== 16) continue
    const path = join(projectsDir, entry)
    try {
      const raw = await readFile(path, 'utf-8')
      const obj = JSON.parse(raw) as Partial<ProjectMeta>
      if (
        typeof obj.workdir === 'string' &&
        typeof obj.created_at === 'number' &&
        typeof obj.last_touch === 'number'
      ) {
        metas.push({
          hash,
          workdir: obj.workdir,
          created_at: obj.created_at,
          last_touch: obj.last_touch,
        })
      } else {
        errors.push(`malformed meta: ${entry}`)
      }
    } catch (err) {
      errors.push(`read meta ${entry}: ${(err as Error).message}`)
    }
  }
  return { metas, errors }
}
