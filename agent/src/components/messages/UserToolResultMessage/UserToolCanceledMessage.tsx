import * as React from 'react'
import { InterruptedByUser } from '../../../components/InterruptedByUser.js'
import { MessageResponse } from '../../../components/MessageResponse.js'

export function UserToolCanceledMessage(): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <InterruptedByUser />
    </MessageResponse>
  )
}
