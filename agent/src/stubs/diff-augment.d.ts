// Module augmentation for 'diff' — adds missing types
import type { Hunk } from 'diff'

declare module 'diff' {
  export type StructuredPatchHunk = Hunk

  // Add timeout to PatchOptions (available in diff >=7)
  export interface PatchOptions {
    timeout?: number
  }
}
