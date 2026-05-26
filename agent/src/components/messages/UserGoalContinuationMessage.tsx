/**
 * Renders the auto-generated continuation user message that the goal
 * Ralph loop enqueues after each completed turn. Identical visual
 * footprint to {@link UserPromptMessage} but prefixed with the ↻ glyph
 * so a user scrolling the transcript can tell at a glance which user
 * turns came from /goal vs. their own typing.
 */

import type { TextBlockParam } from '../../services/api/streamTypes.js'
import React from 'react'
import { Box, Text } from '../../ink.js'
import { HighlightedThinkingText } from './HighlightedThinkingText.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
}

export function UserGoalContinuationMessage({
  addMargin,
  param,
}: Props): React.ReactNode {
  return (
    <Box
      flexDirection="row"
      marginTop={addMargin ? 1 : 0}
      backgroundColor="userMessageBackground"
      paddingRight={1}
      gap={1}
    >
      <Text color="cyan">↻</Text>
      <Box flexDirection="column" flexGrow={1}>
        <HighlightedThinkingText text={param.text} />
      </Box>
    </Box>
  )
}
