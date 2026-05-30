import React from 'react'
import { Box, Text } from '../../ink.js'
import { listApiRecoveryTraces } from '../../services/api/apiRecoveryDiagnostics.js'
import {
  projectApiFailureCards,
  type ApiFailureCard,
  type ApiFailureCardSeverity,
  type ApiFailureCardTimelineItem,
} from '../../services/api/apiFailureCards.js'

const MAX_VISIBLE_API_CARDS = 5
const MAX_VISIBLE_TIMELINE_ITEMS = 3

export function ApiProviderDoctorSection(): React.ReactNode {
  const allCards = projectApiFailureCards(listApiRecoveryTraces(), {
    limit: Number.MAX_SAFE_INTEGER,
  })
  const cards = allCards.slice(0, MAX_VISIBLE_API_CARDS)
  const hiddenCards = Math.max(0, allCards.length - cards.length)

  if (cards.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text bold>API Providers</Text>
      <Box marginLeft={1} flexDirection="column">
        {cards.map(card => (
          <ApiFailureCardView key={card.id} card={card} />
        ))}
        {hiddenCards > 0 && (
          <Text dimColor>
            ... {hiddenCards} more API failure {hiddenCards === 1 ? 'card' : 'cards'} hidden
          </Text>
        )}
      </Box>
    </Box>
  )
}

function ApiFailureCardView({ card }: { card: ApiFailureCard }): React.ReactNode {
  const color = colorFor(card.severity)
  const latest = card.timeline[card.timeline.length - 1]

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text dimColor>└ </Text>
        <Text color={color}>[{labelFor(card.severity)}]</Text>
        <Text> {card.title}</Text>
      </Box>
      <Box marginLeft={3} flexDirection="column">
        <Text dimColor>scope: {card.scope}</Text>
        <Text dimColor>impact: {card.impact}</Text>
        <Text dimColor>model: {card.modelPath || latest?.model || 'unknown'}</Text>
        <Text dimColor>observed: {card.observed}</Text>
        <Text dimColor>recovery: {card.summary}</Text>
        {card.stoppedReason && (
          <Text dimColor>stopped: {card.stoppedReason}</Text>
        )}
        <Text dimColor>next: {card.nextAction}</Text>
        <Text dimColor>
          timeline: {formatTimeline(card.timeline)}
        </Text>
        {card.advanced.requestIds.length > 0 && (
          <Text dimColor>request: {card.advanced.requestIds.join(', ')}</Text>
        )}
        {(card.advanced.timeout || card.advanced.elapsed) && (
          <Text dimColor>
            timing:{' '}
            {[card.advanced.timeout, card.advanced.elapsed]
              .filter(Boolean)
              .join('; ')}
          </Text>
        )}
        {card.advanced.innerCause && (
          <Text dimColor>cause: {card.advanced.innerCause}</Text>
        )}
        {advancedSummary(card) && (
          <Text dimColor>advanced: {advancedSummary(card)}</Text>
        )}
        {card.advanced.policyGate && (
          <Text dimColor>policy: {card.advanced.policyGate}</Text>
        )}
      </Box>
    </Box>
  )
}

function advancedSummary(card: ApiFailureCard): string | undefined {
  const parts = [
    card.advanced.operation ? `op=${card.advanced.operation}` : undefined,
    card.advanced.protocol ? `protocol=${card.advanced.protocol}` : undefined,
    card.advanced.routeId ? `route=${card.advanced.routeId}` : undefined,
    card.advanced.auxiliaryTask
      ? `task=${card.advanced.auxiliaryTask}`
      : undefined,
    card.advanced.ruleIds.length > 0
      ? `rules=${card.advanced.ruleIds.join(',')}`
      : undefined,
    safeHeadersSummary(card.advanced.safeHeaders),
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : undefined
}

function safeHeadersSummary(
  headers: Record<string, string> | undefined,
): string | undefined {
  if (!headers || Object.keys(headers).length === 0) {
    return undefined
  }
  return `headers=${Object.entries(headers)
    .map(([key, value]) => `${key}:${value}`)
    .join(',')}`
}

function formatTimeline(
  timeline: readonly ApiFailureCardTimelineItem[],
): string {
  const hiddenCount = Math.max(0, timeline.length - MAX_VISIBLE_TIMELINE_ITEMS)
  const visible =
    hiddenCount > 0
      ? timeline.slice(timeline.length - MAX_VISIBLE_TIMELINE_ITEMS)
      : timeline
  const parts = visible.map(formatTimelineItem)
  if (hiddenCount > 0) {
    parts.unshift(`... ${hiddenCount} earlier`)
  }
  return parts.join(' | ')
}

function formatTimelineItem(item: ApiFailureCardTimelineItem): string {
  const mutation =
    item.mutation && item.mutation.length > 0
      ? ` +${item.mutation.join(',')}`
      : ''
  const status = item.statusCode !== undefined ? ` HTTP ${item.statusCode}` : ''
  return `#${item.attempt}/${item.maxAttempts} ${formatReason(item.reason)}${status} -> ${item.action}/${item.outcome}${mutation}`
}

function formatReason(reason: ApiFailureCardTimelineItem['reason']): string {
  return reason === 'unknown' ? 'unclassified' : reason
}

function colorFor(
  severity: ApiFailureCardSeverity,
): 'error' | 'warning' | 'suggestion' {
  if (severity === 'error') return 'error'
  if (severity === 'warning') return 'warning'
  return 'suggestion'
}

function labelFor(severity: ApiFailureCardSeverity): string {
  if (severity === 'error') return 'Error'
  if (severity === 'warning') return 'Warning'
  return 'Info'
}

export const _internal = {
  advancedSummary,
  formatTimeline,
}
