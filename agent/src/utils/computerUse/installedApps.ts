import { homedir } from 'os'
import { logForDebugging } from '../debug.js'
import { filterAppsForDescription } from './appNames.js'
import { getComputerUseHostAdapter } from './hostAdapter.js'

const APP_ENUM_TIMEOUT_MS = 1000

// Process-lifetime cache. Apps installed mid-session aren't picked up — the
// description goes into the system prompt and the LLM never re-fetches it,
// so a snapshot from the first call is good enough. mdfind + plutil for ~330
// apps takes ~700ms; without caching we'd pay this on every reconnect of
// the in-process MCP server.
let cached: Promise<string[] | undefined> | undefined

/**
 * Enumerate installed apps via the native executor, timed.
 *
 * Returned to callers building the `request_access` tool description so the
 * LLM has a concrete bundle-id list to pick from. Fails soft — if Spotlight
 * is slow or the executor throws, returns undefined and the description
 * just omits the list (the LLM can still call `list_granted_applications`
 * at runtime, but it loses the hint).
 *
 * Result cached for process lifetime — the description is baked into the
 * system prompt at server-creation time and never re-rendered, so a stale
 * snapshot is fine.
 */
export async function tryGetInstalledAppNames(): Promise<string[] | undefined> {
  if (cached) return cached
  cached = enumerateOnce()
  return cached
}

async function enumerateOnce(): Promise<string[] | undefined> {
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
