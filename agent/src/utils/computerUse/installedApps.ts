import { homedir } from 'os'
import { logForDebugging } from '../debug.js'
import { filterAppsForDescription } from './appNames.js'
import { getComputerUseHostAdapter } from './hostAdapter.js'

const APP_ENUM_TIMEOUT_MS = 1000

/**
 * Enumerate installed apps via the native executor, timed.
 *
 * Returned to callers building the `request_access` tool description so the
 * LLM has a concrete bundle-id list to pick from. Fails soft — if Spotlight
 * is slow or the executor throws, returns undefined and the description
 * just omits the list (the LLM can still call `list_granted_applications`
 * at runtime, but it loses the hint).
 *
 * Used by builtinTools.ts (the active path) and mcpServer.ts (legacy
 * dead-code MCP server, kept for parity).
 */
export async function tryGetInstalledAppNames(): Promise<string[] | undefined> {
  const adapter = getComputerUseHostAdapter()
  const enumP = adapter.executor.listInstalledApps()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutP = new Promise<undefined>(resolve => {
    timer = setTimeout(resolve, APP_ENUM_TIMEOUT_MS, undefined)
  })
  const installed = await Promise.race([enumP, timeoutP])
    .catch(() => undefined)
    .finally(() => clearTimeout(timer))
  if (!installed) {
    // The enumeration continues in the background — swallow late rejections.
    void enumP.catch(() => {})
    logForDebugging(
      `[Computer Use] app enumeration exceeded ${APP_ENUM_TIMEOUT_MS}ms or failed; description omits list`,
    )
    return undefined
  }
  return filterAppsForDescription(installed, homedir())
}
