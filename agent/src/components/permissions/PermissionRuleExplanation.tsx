import chalk from 'chalk'
import React from 'react'
import { Ansi, Box, Text } from '../../ink.js'
import type {
  PermissionDecision,
  PermissionDecisionReason,
} from '../../utils/permissions/PermissionResult.js'
import { permissionRuleValueToString } from '../../utils/permissions/permissionRuleParser.js'
import type { Theme } from '../../utils/theme.js'
import ThemedText from '../design-system/ThemedText.js'

export type PermissionRuleExplanationProps = {
  permissionResult: PermissionDecision
  toolType: 'tool' | 'command' | 'edit' | 'read'
}

type DecisionReasonStrings = {
  reasonString: string
  configString?: string
  /** When set, reasonString is plain text rendered with this theme color instead of <Ansi>. */
  themeColor?: keyof Theme
}

function stringsForDecisionReason(
  reason: PermissionDecisionReason | undefined,
  toolType: 'tool' | 'command' | 'edit' | 'read',
): DecisionReasonStrings | null {
  if (!reason) {
    return null
  }
  switch (reason.type) {
    case 'rule':
      return {
        reasonString: `Permission rule ${chalk.bold(
          permissionRuleValueToString(reason.rule.ruleValue),
        )} requires confirmation for this ${toolType}.`,
        configString:
          reason.rule.source === 'policySettings'
            ? undefined
            : '/permissions to update rules',
      }
    case 'hook': {
      const hookReasonString = reason.reason ? `:\n${reason.reason}` : '.'
      const sourceLabel = reason.hookSource
        ? ` ${chalk.dim(`[${reason.hookSource}]`)}`
        : ''
      return {
        reasonString: `Hook ${chalk.bold(reason.hookName)} requires confirmation for this ${toolType}${hookReasonString}${sourceLabel}`,
        configString: '/hooks to update',
      }
    }
    case 'safetyCheck':
    case 'other':
      return {
        reasonString: reason.reason,
        configString: undefined,
      }
    case 'workingDir':
      return {
        reasonString: reason.reason,
        configString: '/permissions to update rules',
      }
    default:
      return null
  }
}

export function PermissionRuleExplanation({
  permissionResult,
  toolType,
}: PermissionRuleExplanationProps): React.ReactNode {
  const strings = stringsForDecisionReason(
    permissionResult?.decisionReason,
    toolType,
  )
  if (!strings) {
    return null
  }

  const themeColor = strings.themeColor

  return (
    <Box marginBottom={1} flexDirection="column">
      {themeColor ? (
        <ThemedText color={themeColor}>{strings.reasonString}</ThemedText>
      ) : (
        <Text>
          <Ansi>{strings.reasonString}</Ansi>
        </Text>
      )}
      {strings.configString && <Text dimColor>{strings.configString}</Text>}
    </Box>
  )
}
