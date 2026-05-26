import { describe, it, expect } from 'vitest'
import { scoreAppIdSubstringMatch, type StartMenuApp } from '../../../../utils/computerUse/winFallbacks.js'

/**
 * Synthetic StartMenuApp fixture mimicking real Get-StartApps output. The
 * scoring function is pure, so these tests are deterministic without needing
 * PowerShell or a Windows desktop session.
 */
const FIXTURE: StartMenuApp[] = [
  // Calculator — typical UWP, simple PackageName.
  { name: 'Calculator', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', isUwp: true },
  // Edge stable — PackageName has a `.Stable` suffix, so "edge" is followed by `.`
  { name: 'Microsoft Edge', appId: 'Microsoft.MicrosoftEdge.Stable_8wekyb3d8bbwe!App', isUwp: true },
  // Edge updater — PackageName ends in `Update`, so "edge" is followed by `U` (mid-word).
  { name: 'Microsoft Edge Update', appId: 'Microsoft.MicrosoftEdgeUpdate_8wekyb3d8bbwe!Default', isUwp: true },
  // Photos — for unrelated lookups.
  { name: 'Photos', appId: 'Microsoft.Windows.Photos_8wekyb3d8bbwe!App', isUwp: true },
  // Settings — multi-segment PackageName.
  { name: 'Settings', appId: 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel', isUwp: true },
]

describe('scoreAppIdSubstringMatch', () => {
  it('matches "calculator" to WindowsCalculator (word-end at string boundary)', () => {
    const hits = scoreAppIdSubstringMatch('calculator', FIXTURE)
    expect(hits[0]?.app.name).toBe('Calculator')
    // Score should be at least 1 (word-end via string-boundary).
    expect(hits[0]?.score).toBeGreaterThanOrEqual(1)
  })

  it('strips whitespace so "Windows Calculator" still hits Calculator', () => {
    const hits = scoreAppIdSubstringMatch('Windows Calculator', FIXTURE)
    expect(hits[0]?.app.name).toBe('Calculator')
  })

  it('case-insensitive — uppercase input still matches', () => {
    const hits = scoreAppIdSubstringMatch('CALCULATOR', FIXTURE)
    expect(hits[0]?.app.name).toBe('Calculator')
  })

  it('word-boundary scoring picks Edge.Stable over EdgeUpdate', () => {
    // "edge" lands at idx pointing into "microsoftedge" within both candidates.
    //  - Edge.Stable:  followed by `.` (separator) → word-end +1 → score=1
    //  - EdgeUpdate:   followed by `U` (mid-word)  → no word-end bonus → score=0
    // (neither is at a word-start: preceded by 't' from "microsoft").
    const hits = scoreAppIdSubstringMatch('edge', FIXTURE)
    const edgeStable = hits.find(h => h.app.name === 'Microsoft Edge')
    const edgeUpdate = hits.find(h => h.app.name === 'Microsoft Edge Update')
    expect(edgeStable).toBeDefined()
    expect(edgeUpdate).toBeDefined()
    expect(edgeStable!.score).toBeGreaterThan(edgeUpdate!.score)
    // First-place must be Edge.Stable (the higher score wins).
    expect(hits[0]?.app.name).toBe('Microsoft Edge')
  })

  it('returns empty array for inputs shorter than 3 characters', () => {
    expect(scoreAppIdSubstringMatch('ed', FIXTURE)).toEqual([])
    expect(scoreAppIdSubstringMatch('a', FIXTURE)).toEqual([])
    expect(scoreAppIdSubstringMatch('', FIXTURE)).toEqual([])
  })

  it('returns empty array when no candidate contains the substring', () => {
    const hits = scoreAppIdSubstringMatch('definitelynotinstalled', FIXTURE)
    expect(hits).toEqual([])
  })

  it('tiebreaker: shorter packagePart wins on equal score', () => {
    // Two synthetic candidates with the same word-start hit on "calc" and
    // identical scoring (idx=0 → word-start +2 + prefix +1 = 3, no word-end).
    const tieFixture: StartMenuApp[] = [
      { name: 'CalcLong', appId: 'CalcExtraLongPackageName_xxxxxxxxxxxxx!App', isUwp: true },
      { name: 'CalcShort', appId: 'CalcShort_yyyyyyyyyyyyy!App', isUwp: true },
    ]
    const hits = scoreAppIdSubstringMatch('calc', tieFixture)
    expect(hits[0]?.app.name).toBe('CalcShort')
    expect(hits[1]?.app.name).toBe('CalcLong')
  })

  it('includes packagePart in the result for diagnostic logging', () => {
    const hits = scoreAppIdSubstringMatch('calculator', FIXTURE)
    expect(hits[0]?.packagePart).toBe('microsoft.windowscalculator')
  })
})
