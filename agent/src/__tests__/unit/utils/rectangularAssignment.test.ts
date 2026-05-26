import { describe, expect, it } from 'vitest'

import { rectangularAssignment } from '../../../utils/rectangularAssignment.js'

/**
 * Brute-force optimum under the same objective as `rectangularAssignment`:
 *   1. Maximum feasible cardinality (count of non-forbidden pairs)
 *   2. Minimum total cost among assignments achieving that cardinality
 */
function bruteForceOptimum(
  cost: readonly (readonly number[])[],
  forbiddenCost: number,
): { cardinality: number; cost: number } {
  const n = cost.length
  const m = cost[0]?.length ?? 0
  if (n === 0 || m === 0) return { cardinality: 0, cost: 0 }

  function* permutations<T>(arr: T[]): Generator<T[]> {
    if (arr.length <= 1) {
      yield arr.slice()
      return
    }
    for (let i = 0; i < arr.length; i++) {
      const rest = arr.slice(0, i).concat(arr.slice(i + 1))
      for (const tail of permutations(rest)) {
        yield [arr[i]!, ...tail]
      }
    }
  }

  const rowIndices = Array.from({ length: n }, (_, i) => i)
  const colIndices = Array.from({ length: m }, (_, i) => i)

  let bestCard = 0
  let bestCost = 0 // zero-pair assignment is the baseline

  // Prefer larger k, so scan from max down
  for (let k = Math.min(n, m); k >= 1; k--) {
    let foundAtThisK = false
    let minAtThisK = Number.POSITIVE_INFINITY
    for (const rows of combinations(rowIndices, k)) {
      for (const cols of combinations(colIndices, k)) {
        for (const perm of permutations(cols)) {
          let total = 0
          let feasible = true
          for (let idx = 0; idx < k; idx++) {
            const c = cost[rows[idx]!]![perm[idx]!]!
            if (c >= forbiddenCost) {
              feasible = false
              break
            }
            total += c
          }
          if (feasible) {
            foundAtThisK = true
            if (total < minAtThisK) minAtThisK = total
          }
        }
      }
    }
    if (foundAtThisK) {
      bestCard = k
      bestCost = minAtThisK
      return { cardinality: bestCard, cost: bestCost }
    }
  }
  return { cardinality: bestCard, cost: bestCost }
}

function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]]
  if (k > arr.length) return []
  const result: T[][] = []
  for (let i = 0; i <= arr.length - k; i++) {
    for (const rest of combinations(arr.slice(i + 1), k - 1)) {
      result.push([arr[i]!, ...rest])
    }
  }
  return result
}

describe('rectangularAssignment — hand-computed cases', () => {
  it('empty matrices return empty result', () => {
    expect(rectangularAssignment([])).toEqual({
      rowToCol: new Map(),
      totalCost: 0,
    })
    expect(rectangularAssignment([[]])).toEqual({
      rowToCol: new Map(),
      totalCost: 0,
    })
  })

  it('3×3 simple: optimal permutation picks the diagonal of a cheap-diagonal matrix', () => {
    const cost = [
      [1, 9, 9],
      [9, 1, 9],
      [9, 9, 1],
    ]
    const result = rectangularAssignment(cost)
    expect(result.rowToCol.get(0)).toBe(0)
    expect(result.rowToCol.get(1)).toBe(1)
    expect(result.rowToCol.get(2)).toBe(2)
    expect(result.totalCost).toBe(3)
  })

  it('3×3: finds the off-diagonal optimum when diagonal is expensive', () => {
    const cost = [
      [9, 1, 9],
      [9, 9, 1],
      [1, 9, 9],
    ]
    const result = rectangularAssignment(cost)
    expect(result.totalCost).toBe(3)
    expect(result.rowToCol.get(0)).toBe(1)
    expect(result.rowToCol.get(1)).toBe(2)
    expect(result.rowToCol.get(2)).toBe(0)
  })

  it('2×4: more cols than rows — every row assigned, 2 cols unused', () => {
    const cost = [
      [5, 1, 9, 9],
      [9, 5, 1, 9],
    ]
    const result = rectangularAssignment(cost)
    expect(result.rowToCol.size).toBe(2)
    expect(result.totalCost).toBe(2) // 1 + 1
  })

  it('4×2: more rows than cols — exactly 2 rows get assigned', () => {
    const cost = [
      [9, 9],
      [1, 9],
      [9, 1],
      [9, 9],
    ]
    const result = rectangularAssignment(cost)
    expect(result.rowToCol.size).toBe(2)
    expect(result.totalCost).toBe(2)
    expect(result.rowToCol.get(1)).toBe(0)
    expect(result.rowToCol.get(2)).toBe(1)
  })

  it('forbidden cells are never selected', () => {
    const F = 1e9
    const cost = [
      [F, 10],
      [20, F],
    ]
    const result = rectangularAssignment(cost, { forbiddenCost: F })
    expect(result.rowToCol.get(0)).toBe(1)
    expect(result.rowToCol.get(1)).toBe(0)
    expect(result.totalCost).toBe(30)
  })

  it('all-forbidden column leaves no assignment for it', () => {
    const F = 1e9
    const cost = [
      [5, F],
      [5, F],
    ]
    const result = rectangularAssignment(cost, { forbiddenCost: F })
    // Only one row can pick col 0 (both rows prefer it but only one gets it);
    // the other is unassigned (both remaining options are forbidden).
    expect(result.rowToCol.size).toBe(1)
    expect(result.totalCost).toBe(5)
  })

  it('two rows best-match same column — displaced row does NOT go to unknown silently', () => {
    // This is the exact failure mode the fix is targeting.
    // Row 0 and Row 1 both prefer col 0; row 0's cost to col 0 is 0 (exact),
    // but row 1's second-best col 1 is also feasible. Optimal: row 0 → col 0,
    // row 1 → col 1. Greedy (old algorithm) would assign row 0 → col 0,
    // then attempt row 1 → col 0, fail, and drop row 1.
    const cost = [
      [0, 9],
      [2, 4],
    ]
    const result = rectangularAssignment(cost)
    expect(result.rowToCol.get(0)).toBe(0)
    expect(result.rowToCol.get(1)).toBe(1) // the key assertion
    expect(result.totalCost).toBe(4)
  })

  it('falls back to greedy above maxDimension without crashing', () => {
    const N = 3
    const cost = Array.from({ length: N }, (_, i) =>
      Array.from({ length: N }, (_, j) => (i === j ? 1 : 9)),
    )
    const result = rectangularAssignment(cost, { maxDimension: 1 })
    // Greedy on a diagonal-cheap matrix picks the diagonal.
    expect(result.totalCost).toBe(3)
    expect(result.rowToCol.size).toBe(3)
  })
})

describe('rectangularAssignment — property test vs brute-force', () => {
  it('50 random matrices n,m in [1,5] match brute-force optimum', () => {
    const forbiddenCost = 100
    const rng = mulberry32(0xabc123)
    for (let trial = 0; trial < 50; trial++) {
      const n = 1 + Math.floor(rng() * 5)
      const m = 1 + Math.floor(rng() * 5)
      const cost: number[][] = []
      for (let i = 0; i < n; i++) {
        const row: number[] = []
        for (let j = 0; j < m; j++) {
          // Mix of feasible [0..20] and occasional forbidden cells
          row.push(rng() < 0.15 ? forbiddenCost : Math.floor(rng() * 20))
        }
        cost.push(row)
      }
      const got = rectangularAssignment(cost, { forbiddenCost })
      const expected = bruteForceOptimum(cost, forbiddenCost)
      expect({
        cardinality: got.rowToCol.size,
        cost: got.totalCost,
      }).toEqual(expected)
    }
  })
})

// Deterministic PRNG for reproducible property testing.
function mulberry32(seed: number) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
