import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'

import {
  extractToolNameFromJsonLikeText,
  repairToolCallJsonAgainstSchemas,
  repairJsonText,
} from '../jsonRepair.js'

function expectSuccess(input: string) {
  const result = repairJsonText(input)
  if (result.ok === false) {
    throw new Error(result.error)
  }
  expect(result.ok).toBe(true)
  return result
}

describe('repairJsonText', () => {
  it('parses valid JSON without repairs', () => {
    const result = expectSuccess('{"a":1,"b":[true,null,"x"]}')
    expect(result.value).toEqual({ a: 1, b: [true, null, 'x'] })
    expect(result.repairs).toEqual([])
    expect(result.repairedText).toBe('{"a":1,"b":[true,null,"x"]}')
  })

  it('returns already-valid JSON exactly as provided', () => {
    const input = '{\n  "a": 1,\n  "b": [1, 2]\n}'
    const result = expectSuccess(input)
    expect(result.value).toEqual({ a: 1, b: [1, 2] })
    expect(result.repairs).toEqual([])
    expect(result.repairedText).toBe(input)
  })

  it('unwraps fenced JSON', () => {
    const result = expectSuccess('```json\n{"a":1}\n```')
    expect(result.value).toEqual({ a: 1 })
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'stripped_code_fence',
    )
  })

  it('skips leading prose around a JSON payload', () => {
    const result = expectSuccess('Here is the JSON:\n{"a":1}\nThanks!')
    expect(result.value).toEqual({ a: 1 })
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'stripped_leading_prose',
    )
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'ignored_trailing_junk',
    )
  })

  it('accepts single quoted strings', () => {
    const result = expectSuccess("{'a':'x','b':1}")
    expect(result.value).toEqual({ a: 'x', b: 1 })
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'accepted_single_quoted_string',
    )
  })

  it('quotes bare object keys', () => {
    const result = expectSuccess('{a:1,b:true}')
    expect(result.value).toEqual({ a: 1, b: true })
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'quoted_bare_key',
    )
  })

  it('inserts missing colons', () => {
    const result = expectSuccess('{"a" 1, "b" 2}')
    expect(result.value).toEqual({ a: 1, b: 2 })
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'inserted_missing_colon',
    )
  })

  it('treats equals as a colon', () => {
    const result = expectSuccess('{a=1,b=2}')
    expect(result.value).toEqual({ a: 1, b: 2 })
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'treated_equals_as_colon',
    )
  })

  it('inserts missing commas between object properties', () => {
    const result = expectSuccess('{"a":1 "b":2}')
    expect(result.value).toEqual({ a: 1, b: 2 })
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'inserted_missing_comma',
    )
  })

  it('inserts missing commas between array items', () => {
    const result = expectSuccess('[1 2 3]')
    expect(result.value).toEqual([1, 2, 3])
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'inserted_missing_comma',
    )
  })

  it('treats semicolons as commas', () => {
    const result = expectSuccess('{"a":1; "b":2; "c":3}')
    expect(result.value).toEqual({ a: 1, b: 2, c: 3 })
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'treated_semicolon_as_comma',
    )
  })

  it('removes trailing commas and comments', () => {
    const result = expectSuccess(
      '{\n// comment\n"a": 1,\n"b": 2,\n}',
    )
    expect(result.value).toEqual({ a: 1, b: 2 })
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'removed_trailing_comma',
    )
  })

  it('repairs root object bodies without braces', () => {
    const result = expectSuccess('"a":1, b:2')
    expect(result.value).toEqual({ a: 1, b: 2 })
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'wrapped_root_object',
    )
  })

  it('repairs root arrays without brackets', () => {
    const result = expectSuccess('1,2,3')
    expect(result.value).toEqual([1, 2, 3])
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'wrapped_root_array',
    )
  })

  it('repairs root arrays with missing separators when they start like JSON values', () => {
    const result = expectSuccess('1 2 3')
    expect(result.value).toEqual([1, 2, 3])
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'wrapped_root_array',
    )
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'inserted_missing_comma',
    )
  })

  it('inserts null for missing values', () => {
    const result = expectSuccess('{"a":, "b":2}')
    expect(result.value).toEqual({ a: null, b: 2 })
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'inserted_missing_value',
    )
  })

  it('repairs mismatched nested closers', () => {
    const result = expectSuccess('{"a":[1,2}')
    expect(result.value).toEqual({ a: [1, 2] })
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'ignored_mismatched_closer',
    )
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'inserted_closing_brace',
    )
  })

  it('repairs missing nested closing tokens', () => {
    const result = expectSuccess('{"a":[1,2,{"b":3}')
    expect(result.value).toEqual({ a: [1, 2, { b: 3 }] })
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'inserted_closing_brace',
    )
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'inserted_closing_bracket',
    )
  })

  it('closes unterminated strings before structural commas', () => {
    const result = expectSuccess('{"a":"hello, "b":2}')
    expect(result.value).toEqual({ a: 'hello', b: 2 })
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'closed_unterminated_string',
    )
  })

  it('closes unterminated strings before object endings', () => {
    const result = expectSuccess("{a:'hello}")
    expect(result.value).toEqual({ a: 'hello' })
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'closed_unterminated_string',
    )
  })

  it('repairs invalid string escapes', () => {
    const result = expectSuccess('{"a":"hello\\qworld"}')
    expect(result.value).toEqual({ a: 'helloqworld' })
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'repaired_invalid_escape',
    )
  })

  it('normalizes non-standard literals', () => {
    const result = expectSuccess('{a:True,b:None,c:false}')
    expect(result.value).toEqual({ a: true, b: null, c: false })
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'normalized_nonstandard_literal',
    )
  })

  it('treats bareword scalar values as strings', () => {
    const result = expectSuccess('{status:ok, env:prod}')
    expect(result.value).toEqual({ status: 'ok', env: 'prod' })
    expect(result.repairs.map(repair => repair.kind)).toContain(
      'treated_bareword_as_string',
    )
  })

  it('fails on empty input', () => {
    const result = repairJsonText('   ')
    expect(result.ok).toBe(false)
  })

  it('fails on plain prose instead of over-repairing it into JSON', () => {
    const result = repairJsonText('totally not json output')
    expect(result.ok).toBe(false)
  })
})

describe('extractToolNameFromJsonLikeText', () => {
  const knownToolNames = ['Read', 'Bash', 'Edit', 'mcp__repo__search']

  it('extracts a tool name from valid Anthropic-style tool_use JSON', () => {
    const result = extractToolNameFromJsonLikeText(
      '{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"a.ts"}}',
      { knownToolNames },
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('Read')
      expect(result.candidate.matchedKnownTool).toBe(true)
    }
  })

  it('extracts a tool name from valid OpenAI-style tool_calls JSON', () => {
    const result = extractToolNameFromJsonLikeText(
      '{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"Bash","arguments":"{\\"command\\":\\"pwd\\"}"}}]}',
      { knownToolNames },
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('Bash')
    }
  })

  it('extracts a tool name from malformed JSON with missing closing tokens', () => {
    const result = extractToolNameFromJsonLikeText(
      '{type:tool_use,name:"Read",input:{file_path:"src/app.ts"',
      { knownToolNames },
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('Read')
    }
  })

  it('extracts a tool name when the colon after name is missing', () => {
    const result = extractToolNameFromJsonLikeText(
      '{"type":"tool_use","name" "Edit","input":{"file_path":"a.ts"}}',
      { knownToolNames },
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('Edit')
      expect(result.candidate.delimiter).toBe('missing')
    }
  })

  it('extracts a tool name from single quotes and smart quotes', () => {
    const singleQuoted = extractToolNameFromJsonLikeText(
      "{'type':'tool_use','name':'Read','input':{}}",
      { knownToolNames },
    )
    const smartQuoted = extractToolNameFromJsonLikeText(
      '{“type”:“tool_use”,“name”:“Bash”,“input”:{}}',
      { knownToolNames },
    )

    expect(singleQuoted.ok).toBe(true)
    expect(smartQuoted.ok).toBe(true)
    if (singleQuoted.ok) {
      expect(singleQuoted.name).toBe('Read')
    }
    if (smartQuoted.ok) {
      expect(smartQuoted.name).toBe('Bash')
    }
  })

  it('canonicalizes known tool names with casing and punctuation drift', () => {
    const result = extractToolNameFromJsonLikeText(
      '{type:tool_use, toolName: mcp_repo_search, input:{query:"x"}}',
      { knownToolNames },
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('mcp__repo__search')
      expect(result.candidate.extractedName).toBe('mcp_repo_search')
    }
  })

  it('does not accept an unknown tool name when known tools are provided', () => {
    const result = extractToolNameFromJsonLikeText(
      '{"type":"tool_use","name":"DeleteEverything","input":{}}',
      { knownToolNames },
    )

    expect(result.ok).toBe(false)
    expect(result.candidates.some(candidate => candidate.name === 'DeleteEverything')).toBe(true)
  })

  it('can return a high-confidence candidate without a known tool list', () => {
    const result = extractToolNameFromJsonLikeText(
      '{"type":"tool_use","name":"CustomTool","input":{}}',
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.name).toBe('CustomTool')
    }
  })
})

describe('repairToolCallJsonAgainstSchemas', () => {
  const tools = [
    {
      name: 'Read',
      inputSchema: z.strictObject({
        file_path: z.string(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().optional(),
      }),
      propertyAliases: {
        file_path: ['file', 'filePath', 'filepath', 'filename', 'fileName', 'path'],
      },
    },
    {
      name: 'Bash',
      inputSchema: z.strictObject({
        command: z.string(),
        description: z.string().optional(),
        run_in_background: z.boolean().optional(),
      }),
      propertyAliases: {
        command: ['cmd', 'shell', 'script'],
      },
    },
    {
      name: 'Edit',
      inputSchema: z.strictObject({
        file_path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      }),
      propertyAliases: {
        file_path: ['file', 'filePath', 'filepath', 'filename', 'fileName', 'path'],
        old_string: ['old', 'oldString', 'oldText', 'search', 'target'],
        new_string: ['new', 'newString', 'newText', 'replacement', 'replaceWith'],
        replace_all: ['all', 'replaceAll'],
      },
    },
  ]

  it('passes through valid selected-tool input that already matches schema', () => {
    const result = repairToolCallJsonAgainstSchemas(
      '{"type":"tool_use","name":"Read","input":{"file_path":"src/app.ts","offset":2}}',
      tools,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.toolName).toBe('Read')
      expect(result.input).toEqual({
        file_path: 'src/app.ts',
        offset: 2,
      })
      expect(result.needsRepair).toBe(false)
      expect(result.repairs.map(repair => repair.kind)).toContain(
        'extracted_tool_input',
      )
    }
  })

  it('repairs malformed JSON and then fits input to the selected tool schema', () => {
    const result = repairToolCallJsonAgainstSchemas(
      '{type:tool_use,name:Read,input:{filePath:"src/app.ts",offset:"10",junk:true',
      tools,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.toolName).toBe('Read')
      expect(result.input).toEqual({
        file_path: 'src/app.ts',
        offset: 10,
      })
      expect(result.repairs.map(repair => repair.kind)).toContain(
        'parsed_invalid_json',
      )
      expect(result.repairs.map(repair => repair.kind)).toContain('renamed_key')
      expect(result.repairs.map(repair => repair.kind)).toContain(
        'coerced_string_to_number',
      )
      expect(result.repairs.map(repair => repair.kind)).toContain(
        'dropped_unknown_key',
      )
    }
  })

  it('repairs OpenAI-style function arguments strings against the chosen schema', () => {
    const result = repairToolCallJsonAgainstSchemas(
      '{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"Bash","arguments":"{cmd:\'pwd\', run_in_background:\'false\'}"}}]}',
      tools,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.toolName).toBe('Bash')
      expect(result.input).toEqual({
        command: 'pwd',
        run_in_background: false,
      })
      expect(result.repairs.map(repair => repair.kind)).toContain(
        'parsed_arguments_string',
      )
      expect(result.repairs.map(repair => repair.kind)).toContain('renamed_key')
      expect(result.repairs.map(repair => repair.kind)).toContain(
        'coerced_string_to_boolean',
      )
    }
  })

  it('wraps scalar input for single-required-property tools', () => {
    const result = repairToolCallJsonAgainstSchemas(
      '{"type":"tool_use","name":"Read","input":"src/app.ts"}',
      tools,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.input).toEqual({
        file_path: 'src/app.ts',
      })
      expect(result.repairs.map(repair => repair.kind)).toContain(
        'wrapped_scalar_input',
      )
    }
  })

  it('repairs schema aliases for edit-style inputs', () => {
    const result = repairToolCallJsonAgainstSchemas(
      '{"type":"tool_use","name":"Edit","input":{"path":"src/app.ts","old":"before","new":"after","replaceAll":"true"}}',
      tools,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.input).toEqual({
        file_path: 'src/app.ts',
        old_string: 'before',
        new_string: 'after',
        replace_all: true,
      })
    }
  })

  it('fails when the tool name is not known', () => {
    const result = repairToolCallJsonAgainstSchemas(
      '{"type":"tool_use","name":"DeleteEverything","input":{}}',
      tools,
    )

    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.error).toBe('unknown_tool_name')
    }
  })

  it('fails instead of inventing missing required fields', () => {
    const result = repairToolCallJsonAgainstSchemas(
      '{"type":"tool_use","name":"Read","input":{"offset":10}}',
      tools,
    )

    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.error).toBe('schema_mismatch')
    }
  })
})
