/**
 * Integration tests for the tool call repair system.
 *
 * Verifies three properties:
 * 1. The system is working end-to-end (malformed JSON → repaired input → schema validation)
 * 2. The system repairs malformed tool calls to match schema
 * 3. The system does NOT make correct tool calls worse (idempotence / no regression)
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'

import {
  repairToolCallJsonAgainstSchemas,
  repairToolInputAgainstSchema,
  type SchemaGuidedToolDefinition,
} from '../jsonRepair.js'

// ---------------------------------------------------------------------------
// Realistic tool definitions (mirroring actual axiomate tools)
// ---------------------------------------------------------------------------

const readTool: SchemaGuidedToolDefinition = {
  name: 'Read',
  inputSchema: z.strictObject({
    file_path: z.string(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
    pages: z.string().optional(),
  }),
  propertyAliases: {
    file_path: ['file', 'filePath', 'filepath', 'filename', 'fileName', 'path'],
  },
}

const bashTool: SchemaGuidedToolDefinition = {
  name: 'Bash',
  inputSchema: z.strictObject({
    command: z.string(),
    timeout: z.number().optional(),
    description: z.string().optional(),
    run_in_background: z.boolean().optional(),
  }),
  propertyAliases: {
    command: ['cmd', 'shell', 'script'],
  },
}

const editTool: SchemaGuidedToolDefinition = {
  name: 'Edit',
  inputSchema: z.strictObject({
    file_path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().default(false).optional(),
  }),
  propertyAliases: {
    file_path: ['file', 'filePath', 'filepath', 'filename', 'fileName', 'path'],
    old_string: ['old', 'oldString', 'oldText', 'search', 'target'],
    new_string: ['new', 'newString', 'newText', 'replacement', 'replaceWith'],
    replace_all: ['all', 'replaceAll'],
  },
}

const grepTool: SchemaGuidedToolDefinition = {
  name: 'Grep',
  inputSchema: z.strictObject({
    pattern: z.string(),
    path: z.string().optional(),
    glob: z.string().optional(),
    output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
    '-B': z.number().optional(),
    '-A': z.number().optional(),
    '-C': z.number().optional(),
    context: z.number().optional(),
    '-n': z.boolean().optional(),
    '-i': z.boolean().optional(),
    type: z.string().optional(),
    head_limit: z.number().optional(),
    offset: z.number().optional(),
    multiline: z.boolean().optional(),
  }),
  propertyAliases: {
    pattern: ['regex', 'regexp'],
    output_mode: ['outputMode', 'mode'],
  },
}

// A tool with NO propertyAliases — repair should still work for case-style
// variants (camelCase ↔ snake_case) but NOT for abbreviations like cmd→command
const noAliasesTool: SchemaGuidedToolDefinition = {
  name: 'Write',
  inputSchema: z.strictObject({
    file_path: z.string(),
    content: z.string(),
  }),
}

const allTools = [readTool, bashTool, editTool, grepTool, noAliasesTool]

// ---------------------------------------------------------------------------
// 1. System is working end-to-end
// ---------------------------------------------------------------------------

describe('repair system: end-to-end working', () => {
  it('repairToolCallJsonAgainstSchemas processes a full Anthropic-style tool_use JSON', () => {
    const result = repairToolCallJsonAgainstSchemas(
      '{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"src/main.ts"}}',
      allTools,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.toolName).toBe('Read')
      expect(result.input.file_path).toBe('src/main.ts')
    }
  })

  it('repairToolInputAgainstSchema works with already-parsed valid input', () => {
    const result = repairToolInputAgainstSchema(
      { file_path: 'src/main.ts' },
      undefined,
      readTool,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.input.file_path).toBe('src/main.ts')
    }
  })

  it('repairToolInputAgainstSchema works with unparsed malformed JSON', () => {
    const result = repairToolInputAgainstSchema(
      {}, // empty parsed input (JSON.parse failed)
      '{"file_path": "src/main.ts"', // truncated
      readTool,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.input.file_path).toBe('src/main.ts')
    }
  })
})

// ---------------------------------------------------------------------------
// 2. System repairs malformed tool calls to match schema
// ---------------------------------------------------------------------------

describe('repair system: malformed → valid', () => {
  describe('JSON-level repairs', () => {
    it('repairs truncated JSON (missing closing braces)', () => {
      const result = repairToolCallJsonAgainstSchemas(
        '{"type":"tool_use","name":"Read","input":{"file_path":"src/app.ts"',
        allTools,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.input.file_path).toBe('src/app.ts')
      }
    })

    it('repairs single-quoted JSON', () => {
      const result = repairToolCallJsonAgainstSchemas(
        "{'type':'tool_use','name':'Bash','input':{'command':'ls -la'}}",
        allTools,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.input.command).toBe('ls -la')
      }
    })

    it('repairs bare keys (no quotes)', () => {
      const result = repairToolCallJsonAgainstSchemas(
        '{type:tool_use,name:Read,input:{file_path:"src/index.ts"}}',
        allTools,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.input.file_path).toBe('src/index.ts')
      }
    })

    it('repairs JSON wrapped in code fence', () => {
      const result = repairToolCallJsonAgainstSchemas(
        '```json\n{"type":"tool_use","name":"Bash","input":{"command":"pwd"}}\n```',
        allTools,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.input.command).toBe('pwd')
      }
    })
  })

  describe('property name repairs (with declared aliases)', () => {
    it('repairs "cmd" → "command" using Bash tool aliases', () => {
      const result = repairToolCallJsonAgainstSchemas(
        '{"type":"tool_use","name":"Bash","input":{"cmd":"git status"}}',
        allTools,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.input.command).toBe('git status')
      }
    })

    it('repairs "path" → "file_path" using Read tool aliases', () => {
      const result = repairToolCallJsonAgainstSchemas(
        '{"type":"tool_use","name":"Read","input":{"path":"README.md"}}',
        allTools,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.input.file_path).toBe('README.md')
      }
    })

    it('repairs "old" → "old_string" and "new" → "new_string" for Edit', () => {
      const result = repairToolCallJsonAgainstSchemas(
        '{"type":"tool_use","name":"Edit","input":{"path":"a.ts","old":"before","new":"after"}}',
        allTools,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.input.file_path).toBe('a.ts')
        expect(result.input.old_string).toBe('before')
        expect(result.input.new_string).toBe('after')
      }
    })
  })

  describe('property name repairs (without aliases, Levenshtein only)', () => {
    it('repairs camelCase "filePath" → "file_path" via token overlap', () => {
      const result = repairToolCallJsonAgainstSchemas(
        '{"type":"tool_use","name":"Write","input":{"filePath":"a.ts","content":"hello"}}',
        allTools,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.input.file_path).toBe('a.ts')
        expect(result.input.content).toBe('hello')
      }
    })

    it('does NOT repair "cmd" → "content" for Write (no alias, low similarity)', () => {
      // Without aliases, "cmd" is not close enough to "content" (Levenshtein too far).
      // Write requires both file_path and content, so dropping "cmd" leaves content missing → fail.
      const result = repairToolCallJsonAgainstSchemas(
        '{"type":"tool_use","name":"Write","input":{"cmd":"hello","file_path":"a.ts"}}',
        allTools,
      )
      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toBe('schema_mismatch')
      }
    })
  })

  describe('type coercion repairs', () => {
    it('coerces string "10" → number 10 for offset', () => {
      const result = repairToolCallJsonAgainstSchemas(
        '{"type":"tool_use","name":"Read","input":{"file_path":"a.ts","offset":"10"}}',
        allTools,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.input.offset).toBe(10)
      }
    })

    it('coerces string "true" → boolean true', () => {
      const result = repairToolCallJsonAgainstSchemas(
        '{"type":"tool_use","name":"Bash","input":{"command":"pwd","run_in_background":"true"}}',
        allTools,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.input.run_in_background).toBe(true)
      }
    })

    it('wraps scalar input for single-required-property when possible', () => {
      // Read has file_path as the only non-optional property
      // But it has multiple optional properties so this is NOT a single-property tool
      // Write has exactly 2 required properties, so scalar wrap won't work
      // This test documents the boundary
      const result = repairToolCallJsonAgainstSchemas(
        '{"type":"tool_use","name":"Write","input":"hello.ts"}',
        allTools,
      )
      // Write has 2 required properties (file_path, content), so scalar can't be assigned
      expect(result.ok).toBe(false)
    })
  })

  describe('combined repairs (multiple issues at once)', () => {
    it('repairs bare keys + missing quotes + type coercion + key rename', () => {
      const result = repairToolCallJsonAgainstSchemas(
        '{type:tool_use,name:Read,input:{filePath:src/app.ts,offset:"5"',
        allTools,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.toolName).toBe('Read')
        expect(result.input.file_path).toBe('src/app.ts')
        expect(result.input.offset).toBe(5)
      }
    })

    it('repairs OpenAI-style function.arguments with nested malformed JSON', () => {
      const result = repairToolCallJsonAgainstSchemas(
        '{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"Edit","arguments":"{\\"path\\":\\"a.ts\\",\\"old\\":\\"x\\",\\"new\\":\\"y\\"}"}}]}',
        allTools,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.toolName).toBe('Edit')
        expect(result.input.file_path).toBe('a.ts')
        expect(result.input.old_string).toBe('x')
        expect(result.input.new_string).toBe('y')
      }
    })
  })
})

// ---------------------------------------------------------------------------
// 3. System does NOT make correct tool calls worse (idempotence / no regression)
// ---------------------------------------------------------------------------

describe('repair system: no regression on correct input', () => {
  /** Valid inputs for each tool — these must pass through UNCHANGED */
  const validCases: Array<{
    label: string
    tool: SchemaGuidedToolDefinition
    input: Record<string, unknown>
  }> = [
    {
      label: 'Read with all fields',
      tool: readTool,
      input: { file_path: 'src/main.ts', offset: 10, limit: 50 },
    },
    {
      label: 'Read with only required field',
      tool: readTool,
      input: { file_path: 'README.md' },
    },
    {
      label: 'Bash simple command',
      tool: bashTool,
      input: { command: 'ls -la' },
    },
    {
      label: 'Bash with all optional fields',
      tool: bashTool,
      input: { command: 'npm test', timeout: 30000, description: 'Run tests', run_in_background: true },
    },
    {
      label: 'Edit with all fields',
      tool: editTool,
      input: { file_path: 'a.ts', old_string: 'before', new_string: 'after', replace_all: true },
    },
    {
      label: 'Grep with pattern only',
      tool: grepTool,
      input: { pattern: 'TODO' },
    },
    {
      label: 'Grep with many options',
      tool: grepTool,
      input: { pattern: 'function\\s+\\w+', path: 'src/', glob: '*.ts', output_mode: 'content' as const, '-A': 3, '-B': 1, '-i': true, head_limit: 50 },
    },
    {
      label: 'Write with required fields',
      tool: noAliasesTool,
      input: { file_path: 'output.txt', content: 'hello world' },
    },
  ]

  describe('repairToolInputAgainstSchema preserves valid input exactly', () => {
    for (const { label, tool, input } of validCases) {
      it(`${label}`, () => {
        const result = repairToolInputAgainstSchema(input, undefined, tool)
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.input).toEqual(input)
          // needsRepair should be false for already-valid input
          // (there may be an 'extracted_tool_input' marker but no actual repair)
        }
      })
    }
  })

  describe('repairToolCallJsonAgainstSchemas preserves valid JSON exactly', () => {
    for (const { label, tool, input } of validCases) {
      it(`${label}`, () => {
        const json = JSON.stringify({
          type: 'tool_use',
          id: 'toolu_test',
          name: tool.name,
          input,
        })
        const result = repairToolCallJsonAgainstSchemas(json, allTools)
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.toolName).toBe(tool.name)
          expect(result.input).toEqual(input)
        }
      })
    }
  })

  describe('repair does not invent data', () => {
    it('does not add default values for missing optional fields', () => {
      const result = repairToolInputAgainstSchema(
        { file_path: 'a.ts' },
        undefined,
        readTool,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(Object.keys(result.input)).toEqual(['file_path'])
        expect(result.input.offset).toBeUndefined()
        expect(result.input.limit).toBeUndefined()
      }
    })

    it('does not invent required fields that are missing', () => {
      // Read requires file_path — repair should fail, not invent it
      const result = repairToolInputAgainstSchema(
        { offset: 10 },
        undefined,
        readTool,
      )
      expect(result.ok).toBe(false)
    })

    it('does not rename keys that happen to be substrings of schema keys', () => {
      // "pat" is NOT close enough to "pattern" at the 0.72 threshold
      const result = repairToolCallJsonAgainstSchemas(
        '{"type":"tool_use","name":"Grep","input":{"pat":"TODO"}}',
        allTools,
      )
      // Should fail because "pat" → "pattern" similarity is too low without alias
      expect(result.ok).toBe(false)
    })
  })

  describe('enum values are preserved exactly', () => {
    it('preserves correct enum values without case change', () => {
      const result = repairToolInputAgainstSchema(
        { pattern: 'test', output_mode: 'content' },
        undefined,
        grepTool,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.input.output_mode).toBe('content')
      }
    })

    it('repairs enum case mismatch (Content → content)', () => {
      const result = repairToolCallJsonAgainstSchemas(
        '{"type":"tool_use","name":"Grep","input":{"pattern":"test","output_mode":"Content"}}',
        allTools,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.input.output_mode).toBe('content')
      }
    })
  })
})

// ---------------------------------------------------------------------------
// Safety boundaries: things the repair system must NEVER do
// ---------------------------------------------------------------------------

describe('repair system: safety boundaries', () => {
  it('rejects unknown tool names even if JSON is valid', () => {
    const result = repairToolCallJsonAgainstSchemas(
      '{"type":"tool_use","name":"DropDatabase","input":{"target":"production"}}',
      allTools,
    )
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.error).toBe('unknown_tool_name')
    }
  })

  it('rejects empty input', () => {
    const result = repairToolInputAgainstSchema({}, undefined, readTool)
    expect(result.ok).toBe(false)
  })

  it('rejects pure prose (not JSON-like at all)', () => {
    const result = repairToolCallJsonAgainstSchemas(
      'I would like to read the file src/main.ts please',
      allTools,
    )
    expect(result.ok).toBe(false)
  })

  it('does not cross-contaminate between tools (Read input to Bash)', () => {
    // Even if the JSON says "Bash", file_path is not a Bash property
    const result = repairToolCallJsonAgainstSchemas(
      '{"type":"tool_use","name":"Bash","input":{"file_path":"a.ts"}}',
      allTools,
    )
    // Bash requires "command" — file_path alone should fail
    expect(result.ok).toBe(false)
  })
})
