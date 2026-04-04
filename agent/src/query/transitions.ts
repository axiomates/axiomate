// Stub: query transitions — type-only imports from query.ts.

/** Signals that the query loop should terminate. */
export type Terminal = {
  readonly reason: string
  [key: string]: unknown
}

/** Signals that the query loop should continue with another iteration. */
export type Continue = {
  readonly reason: string
  [key: string]: unknown
}

/**
 * Feature-flag accessor — always returns false in this stub build,
 * so feature-gated transition paths are never taken.
 */
export function feature(_name: string): boolean {
  return false
}
