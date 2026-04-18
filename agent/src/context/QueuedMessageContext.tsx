import * as React from 'react'
import { Box } from '../ink.js'

type QueuedMessageContextValue = {
  isQueued: boolean
  isFirst: boolean
  /** Width reduction for container padding (e.g., 4 for paddingX={2}) */
  paddingWidth: number
}

const QueuedMessageContext = React.createContext<
  QueuedMessageContextValue | undefined
>(undefined)

export function useQueuedMessage(): QueuedMessageContextValue | undefined {
  return React.useContext(QueuedMessageContext)
}

const PADDING_X = 2

type Props = {
  isFirst: boolean
  children: React.ReactNode
}

export function QueuedMessageProvider({
  isFirst,
  children,
}: Props): React.ReactNode {
  const value = React.useMemo(
    () => ({ isQueued: true, isFirst, paddingWidth: PADDING_X * 2 }),
    [isFirst],
  )

  return (
    <QueuedMessageContext.Provider value={value}>
      <Box paddingX={PADDING_X}>{children}</Box>
    </QueuedMessageContext.Provider>
  )
}
