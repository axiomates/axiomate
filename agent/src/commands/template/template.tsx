import * as React from 'react'
import { Box, Text } from '../../ink.js'
import chalk from 'chalk'
import type { CommandResultDisplay } from '../../commands.js'
import { Select } from '../../components/CustomSelect/select.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  deleteModelTemplateFromConfig,
  deleteTemplateFromConfig,
  getGlobalConfig,
} from '../../utils/config.js'
import {
  getBuiltinModelTemplates,
  getBuiltinTemplates,
  isBuiltinModelTemplate,
  isBuiltinVendor,
  PROTOCOLS,
  resolveTemplate,
  type VendorTemplate,
} from '../../services/api/vendorTemplates.js'
import { TemplateEditor } from './TemplateEditor.js'

type Group = 'vendor' | 'model'

const HELP_TEXT =
  'Subcommands (group is `vendor` or `model`):\n' +
  '  /template vendor list                 — list built-in + custom vendor templates\n' +
  '  /template vendor show <name>          — print resolved vendor template JSON\n' +
  '  /template vendor new                  — create custom vendor template (interactive)\n' +
  '  /template vendor delete <name>        — delete custom vendor template\n' +
  '  /template model list                  — list built-in + custom model templates\n' +
  '  /template model show <name>           — print model template JSON\n' +
  '  /template model new                   — create custom model template (interactive)\n' +
  '  /template model delete <name>         — delete custom model template\n' +
  '\n' +
  'Vendor templates translate the neutral thinking config to wire fields per\n' +
  'gateway. Model templates overlay explicitly selected model-specific quirks\n' +
  '(e.g. DeepSeek V4+ reasoning/thinking replay).'

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const trimmed = (args ?? '').trim()
  const parts = trimmed.split(/\s+/).filter(Boolean)
  const first = parts[0]

  // No args / help — show help.
  if (!first || first === '--help' || first === '-h' || first === 'help') {
    onDone(HELP_TEXT, { display: 'system' })
    return
  }

  // First token must be `vendor` or `model`.
  if (first !== 'vendor' && first !== 'model') {
    onDone(
      `Unknown /template group: '${first}'. Run /template help for usage.`,
      { display: 'system' },
    )
    return
  }
  const group: Group = first
  const sub = parts[1] ?? 'list'

  if (sub === 'list' || sub === 'ls') {
    return <ListTemplatesAndClose group={group} onDone={onDone} />
  }

  if (sub === 'show') {
    const name = parts.slice(2).join(' ')
    if (!name) {
      onDone(`Usage: /template ${group} show <name>`, { display: 'system' })
      return
    }
    return <ShowTemplateAndClose group={group} name={name} onDone={onDone} />
  }

  if (sub === 'new' || sub === 'add') {
    return <NewTemplateAndClose group={group} onDone={onDone} />
  }

  if (sub === 'delete' || sub === 'rm') {
    const name = parts.slice(2).join(' ')
    if (!name) {
      onDone(`Usage: /template ${group} delete <name>`, { display: 'system' })
      return
    }
    return <DeleteTemplateAndClose group={group} name={name} onDone={onDone} />
  }

  onDone(
    `Unknown /template ${group} subcommand: '${sub}'. Try /template help.`,
    { display: 'system' },
  )
}

function ListTemplatesAndClose({
  group,
  onDone,
}: {
  group: Group
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}): React.ReactNode {
  React.useEffect(() => {
    const builtins =
      group === 'vendor'
        ? Object.keys(getBuiltinTemplates()).sort()
        : Object.keys(getBuiltinModelTemplates()).sort()
    const customsRecord =
      group === 'vendor'
        ? (getGlobalConfig().templates ?? {})
        : (getGlobalConfig().modelTemplates ?? {})
    const customs = Object.keys(customsRecord).sort()

    const headline = group === 'vendor' ? 'vendor templates' : 'model templates'
    const lines = [
      chalk.bold(`Built-in ${headline}:`),
      ...builtins.map(n => `  ${chalk.cyan(n)}`),
    ]
    if (customs.length > 0) {
      lines.push('', chalk.bold(`Custom ${headline}:`))
      for (const n of customs) {
        const tpl = (customsRecord as Record<string, { extends?: string }>)[n]!
        const ext = tpl.extends ? ` (extends ${chalk.dim(tpl.extends)})` : ''
        lines.push(`  ${chalk.cyan(n)}${ext}`)
      }
    } else {
      lines.push(
        '',
        chalk.dim(`No custom ${headline}. Run /template ${group} new to add one.`),
      )
    }
    onDone(lines.join('\n'))
  }, [group, onDone])
  return null
}

function ShowTemplateAndClose({
  group,
  name,
  onDone,
}: {
  group: Group
  name: string
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}): React.ReactNode {
  React.useEffect(() => {
    if (group === 'vendor') {
      const result = formatVendorTemplateForShow(
        name,
        getGlobalConfig().templates ?? {},
      )
      if (result.ok === false) {
        onDone(
          result.message,
          { display: 'system' },
        )
        return
      }
      onDone(result.text)
      return
    }
    // group === 'model'
    const builtins = getBuiltinModelTemplates()
    const customs = getGlobalConfig().modelTemplates ?? {}
    const tpl =
      (customs as Record<string, unknown>)[name] ??
      (builtins as Record<string, unknown>)[name]
    if (!tpl) {
      onDone(
        `Model template '${name}' not found. Run /template model list.`,
        { display: 'system' },
      )
      return
    }
    onDone(
      `${chalk.bold(name)}${name in customs ? ' (custom)' : ' (built-in)'}\n` +
        JSON.stringify(tpl, null, 2),
    )
  }, [group, name, onDone])
  return null
}

export function formatVendorTemplateForShow(
  name: string,
  customs: Record<string, VendorTemplate>,
):
  | { ok: true; text: string }
  | { ok: false; message: string } {
  const builtins = getBuiltinTemplates()
  const isProtocol = PROTOCOLS.includes(name as (typeof PROTOCOLS)[number])
  if (!(name in builtins) && !(name in customs) && !isProtocol) {
    return {
      ok: false,
      message: `Vendor template '${name}' not found. Run /template vendor list.`,
    }
  }

  try {
    const resolved = resolveTemplate(name, customs)
    return {
      ok: true,
      text:
        `${chalk.bold(name)}${name in customs ? ' (custom)' : ' (built-in)'}\n` +
        JSON.stringify(resolved, null, 2),
    }
  } catch (err) {
    return {
      ok: false,
      message: `Error resolving '${name}': ${(err as Error).message}`,
    }
  }
}

function NewTemplateAndClose({
  group,
  onDone,
}: {
  group: Group
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}): React.ReactNode {
  return (
    <TemplateEditor
      kind={group}
      onComplete={name =>
        onDone(
          `Template ${chalk.bold(name)} saved to ~/.axiomate.json (${group})`,
        )
      }
      onCancel={reason => onDone(reason ?? 'Cancelled', { display: 'system' })}
    />
  )
}

function DeleteTemplateAndClose({
  group,
  name,
  onDone,
}: {
  group: Group
  name: string
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}): React.ReactNode {
  const customsRecord =
    group === 'vendor'
      ? (getGlobalConfig().templates ?? {})
      : (getGlobalConfig().modelTemplates ?? {})
  const isBuiltin =
    group === 'vendor' ? isBuiltinVendor(name) : isBuiltinModelTemplate(name)
  const exists = name in customsRecord

  React.useEffect(() => {
    if (isBuiltin) {
      onDone(
        `'${name}' is a built-in ${group} template and cannot be deleted.`,
        { display: 'system' },
      )
    } else if (!exists) {
      onDone(`Custom ${group} template '${name}' not found.`, {
        display: 'system',
      })
    }
  }, [group, name, isBuiltin, exists, onDone])

  if (isBuiltin || !exists) return null

  const followUpHint =
    group === 'vendor'
      ? `Models referencing this template via \`vendor: "${name}"\` will fail validation until the field is updated.`
      : `Models referencing this template via \`modelTemplate: "${name}"\` will fail validation until the field is updated.`

  return (
    <Box flexDirection="column" paddingLeft={1} gap={1}>
      <Text>
        Delete custom {group} template <Text bold>{name}</Text>?
      </Text>
      <Text dimColor>{followUpHint}</Text>
      <Select
        options={[
          { label: 'No — keep template', value: 'no' },
          { label: 'Yes — delete', value: 'yes' },
        ]}
        onChange={v => {
          if (v === 'yes') {
            if (group === 'vendor') {
              deleteTemplateFromConfig(name)
            } else {
              deleteModelTemplateFromConfig(name)
            }
            onDone(`Deleted ${group} template ${chalk.bold(name)}`)
          } else {
            onDone(`Kept ${group} template ${chalk.bold(name)}`, {
              display: 'system',
            })
          }
        }}
        onCancel={() =>
          onDone(`Kept ${group} template ${chalk.bold(name)}`, {
            display: 'system',
          })
        }
      />
    </Box>
  )
}
