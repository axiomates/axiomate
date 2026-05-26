import { describe, expect, it } from 'vitest'
import {
  initialModelEditorState,
  modelEditorReducer,
} from '../../../../commands/model/ModelEditor.reducer.js'

describe('modelEditorReducer', () => {
  it('starts in opening phase with no reusePath', () => {
    expect(initialModelEditorState).toEqual({ phase: 'opening' })
  })

  it('editorSucceeded → done', () => {
    expect(
      modelEditorReducer({ phase: 'opening' }, { type: 'editorSucceeded' }),
    ).toEqual({ phase: 'done' })
  })

  it('editorCancelled → done', () => {
    expect(
      modelEditorReducer({ phase: 'opening' }, { type: 'editorCancelled' }),
    ).toEqual({ phase: 'done' })
  })

  it('editorMissingModel → done', () => {
    expect(
      modelEditorReducer({ phase: 'opening' }, { type: 'editorMissingModel' }),
    ).toEqual({ phase: 'done' })
  })

  it('editorInvalid → invalid carrying error and tempPath', () => {
    expect(
      modelEditorReducer(
        { phase: 'opening' },
        {
          type: 'editorInvalid',
          error: 'Invalid JSON: Unexpected token',
          tempPath: '/tmp/x.json',
        },
      ),
    ).toEqual({
      phase: 'invalid',
      error: 'Invalid JSON: Unexpected token',
      tempPath: '/tmp/x.json',
    })
  })

  it('retry from invalid → opening with reusePath', () => {
    const next = modelEditorReducer(
      { phase: 'invalid', error: 'e', tempPath: '/tmp/abc.json' },
      { type: 'retry' },
    )
    expect(next).toEqual({ phase: 'opening', reusePath: '/tmp/abc.json' })
  })

  it('retry from non-invalid is a no-op', () => {
    const state = { phase: 'opening' as const }
    const next = modelEditorReducer(state, { type: 'retry' })
    expect(next).toBe(state)
  })

  it('cancel → done', () => {
    expect(
      modelEditorReducer(
        { phase: 'invalid', error: 'e', tempPath: '/t' },
        { type: 'cancel' },
      ),
    ).toEqual({ phase: 'done' })
  })
})
