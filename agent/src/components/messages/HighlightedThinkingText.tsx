import figures from 'figures'
import * as React from 'react'
import { useContext } from 'react'
import { Text } from '../../ink.js'
import { MessageActionsSelectedContext } from '../messageActions.js'

type Props = {
  text: string
}

export function HighlightedThinkingText({ text }: Props): React.ReactNode {
  const isSelected = useContext(MessageActionsSelectedContext)
  const pointerColor = isSelected ? 'suggestion' : 'subtle'
  return (
    <Text>
      <Text color={pointerColor}>{figures.pointer} </Text>
      <Text color="text">{text}</Text>
    </Text>
  )
}
