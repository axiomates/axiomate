import type { UUID } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
// Bridge config removed — inline stubs
const getBridgeBaseUrlOverride = (): string | undefined => undefined
const getBridgeTokenOverride = (): string | undefined => undefined
import type { ToolUseContext } from '../../Tool.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import {
  getTranscriptPath,
  saveAgentName,
  saveCustomTitle,
} from '../../utils/sessionStorage.js'
import { isTeammate } from '../../utils/teammate.js'
import { generateSessionName } from './generateSessionName.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<null> {
  // Prevent teammates from renaming - their names are set by team leader
  if (isTeammate()) {
    onDone(
      'Cannot rename: This session is a swarm teammate. Teammate names are set by the team leader.',
      { display: 'system' },
    )
    return null
  }

  let newName: string
  if (!args || args.trim() === '') {
    const generated = await generateSessionName(
      getMessagesAfterCompactBoundary(context.messages),
      context.abortController.signal,
    )
    if (!generated) {
      onDone(
        'Could not generate a name: no conversation context yet. Usage: /rename <name>',
        { display: 'system' },
      )
      return null
    }
    newName = generated
  } else {
    newName = args.trim()
  }

  const sessionId = getSessionId() as UUID
  const fullPath = getTranscriptPath()

  // Always save the custom title (session name)
  await saveCustomTitle(sessionId, newName, fullPath)

  // v2 env-less bridge stores cse_* in replBridgeSessionId —
  // updateBridgeSessionTitle retags internally for the compat endpoint.
  const appState = context.getAppState()
  const bridgeSessionId = appState.replBridgeSessionId
  if (bridgeSessionId) {
    const tokenOverride = getBridgeTokenOverride()
    // Bridge createSession module removed — skip remote title sync
  }

  // Also persist as the session's agent name for prompt-bar display
  await saveAgentName(sessionId, newName, fullPath)
  context.setAppState(prev => ({
    ...prev,
    standaloneAgentContext: {
      ...prev.standaloneAgentContext,
      name: newName,
    },
  }))

  onDone(`Session renamed to: ${newName}`, { display: 'system' })
  return null
}
