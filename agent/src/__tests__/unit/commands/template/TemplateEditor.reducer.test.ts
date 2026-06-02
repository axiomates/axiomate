import { describe, expect, it } from 'vitest'
import {
  initialTemplateEditorState,
  templateEditorReducer,
} from '../../../../commands/template/TemplateEditor.reducer.js'

describe('templateEditorReducer', () => {
  it('starts in name phase', () => {
    expect(initialTemplateEditorState).toEqual({ phase: 'name', kind: 'vendor' })
  })

  it('submitName advances to extends with the chosen name', () => {
    const next = templateEditorReducer(
      { phase: 'name', kind: 'vendor' },
      { type: 'submitName', name: 'my-vendor' },
    )
    expect(next).toEqual({ phase: 'extends', kind: 'vendor', name: 'my-vendor' })
  })

  it('submitExtends from extends → opening with both name and baseName', () => {
    const next = templateEditorReducer(
      { phase: 'extends', kind: 'vendor', name: 'my-vendor' },
      { type: 'submitExtends', baseName: 'openai-chat' },
    )
    expect(next).toEqual({
      phase: 'opening',
kind: 'vendor',
      name: 'my-vendor',
      baseName: 'openai-chat',
    })
  })

  it('submitExtends from non-extends phase is a no-op', () => {
    const state = { phase: 'name' as const, kind: 'vendor' as const }
    const next = templateEditorReducer(state, {
      type: 'submitExtends',
      baseName: 'openai-chat',
    })
    expect(next).toBe(state)
  })

  it('editorSucceeded transitions to done', () => {
    const next = templateEditorReducer(
      { phase: 'opening', kind: 'vendor', name: 'foo', baseName: 'openai-chat' },
      { type: 'editorSucceeded' },
    )
    expect(next).toEqual({ phase: 'done', kind: 'vendor' })
  })

  it('editorCancelled transitions to done', () => {
    const next = templateEditorReducer(
      { phase: 'opening', kind: 'vendor', name: 'foo', baseName: 'openai-chat' },
      { type: 'editorCancelled' },
    )
    expect(next).toEqual({ phase: 'done', kind: 'vendor' })
  })

  it('editorInvalid → invalid phase carrying error and tempPath', () => {
    const next = templateEditorReducer(
      { phase: 'opening', kind: 'vendor', name: 'foo', baseName: 'openai-chat' },
      {
        type: 'editorInvalid',
        error: 'Schema validation failed:\n  • effort.patch: required',
        tempPath: '/tmp/xyz.json',
      },
    )
    expect(next).toEqual({
      phase: 'invalid',
kind: 'vendor',
      name: 'foo',
      baseName: 'openai-chat',
      error: 'Schema validation failed:\n  • effort.patch: required',
      tempPath: '/tmp/xyz.json',
    })
  })

  it('retry from invalid → opening with reusePath set', () => {
    const next = templateEditorReducer(
      {
        phase: 'invalid',
kind: 'vendor',
        name: 'foo',
        baseName: 'openai-chat',
        error: 'oops',
        tempPath: '/tmp/abc.json',
      },
      { type: 'retry' },
    )
    expect(next).toEqual({
      phase: 'opening',
kind: 'vendor',
      name: 'foo',
      baseName: 'openai-chat',
      reusePath: '/tmp/abc.json',
    })
  })

  it('retry from non-invalid phase is a no-op', () => {
    const state = { phase: 'name' as const, kind: 'vendor' as const }
    const next = templateEditorReducer(state, { type: 'retry' })
    expect(next).toBe(state)
  })

  it('cancel from any phase → done', () => {
    expect(
      templateEditorReducer({ phase: 'name', kind: 'vendor' }, { type: 'cancel' }),
    ).toEqual({ phase: 'done', kind: 'vendor' })
    expect(
      templateEditorReducer(
        { phase: 'extends', kind: 'vendor', name: 'x' },
        { type: 'cancel' },
      ),
    ).toEqual({ phase: 'done', kind: 'vendor' })
    expect(
      templateEditorReducer(
        {
          phase: 'invalid',
kind: 'vendor',
          name: 'x',
          baseName: 'y',
          error: 'e',
          tempPath: '/t',
        },
        { type: 'cancel' },
      ),
    ).toEqual({ phase: 'done', kind: 'vendor' })
  })

  it('backToName from extends → name', () => {
    const next = templateEditorReducer(
      { phase: 'extends', kind: 'vendor', name: 'my-vendor' },
      { type: 'backToName' },
    )
    expect(next).toEqual({ phase: 'name', kind: 'vendor' })
  })
})
