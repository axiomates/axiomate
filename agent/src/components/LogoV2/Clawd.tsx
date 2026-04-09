import * as React from 'react'
import { Box, Text } from '../../ink.js'

export type ClawdPose =
  | 'default'
  | 'arms-up'
  | 'look-left'
  | 'look-right'

type Props = {
  pose?: ClawdPose
}

// 5-row ASCII cat. Pure foreground color, no background tricks.
// Uses clawd_body color for the whole cat.

const CATS: Record<ClawdPose, string[]> = {
  default: [
    '  /\\_/\\  ',
    ' ( ●ω● ) ',
    '   >  <  ',
    '  /|  |\\  ',
    ' (_|  |_) ',
  ],
  'look-left': [
    '  /\\_/\\  ',
    ' (●ω●  ) ',
    '   >  <  ',
    '  /|  |\\  ',
    ' (_|  |_) ',
  ],
  'look-right': [
    '  /\\_/\\  ',
    ' (  ●ω●) ',
    '   >  <  ',
    '  /|  |\\  ',
    ' (_|  |_) ',
  ],
  'arms-up': [
    '  /\\_/\\  ',
    '\\( ●.● )/',
    '   |  |  ',
    '   |  |   ',
    '  (_  _)  ',
  ],
}

export function Clawd({ pose = 'default' }: Props = {}): React.ReactNode {
  const lines = CATS[pose]
  return (
    <Box flexDirection="column" alignItems="center">
      {lines.map((line, i) => (
        <Text key={i} color="clawd_body">{line}</Text>
      ))}
    </Box>
  )
}
