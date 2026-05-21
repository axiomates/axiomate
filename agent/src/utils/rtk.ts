import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { isInBundledMode } from './bundledMode.js'
import { logForDebugging } from './debug.js'

// Per-attempt timeout for rtk rewrite. Observed hot-path P99 in production
// is ~110ms, but cold spawn on Windows + AV scanning regularly exceeds
// 500ms. 1000ms is comfortably above the cold-spawn ceiling without making
// users wait noticeably when rtk is genuinely broken — combined with the
// 3-attempt retry below the worst-case wall-clock is ~3.15s, which beats
// the 2000ms-per-attempt design (~6.15s worst case) on user-perceived UX.
const RTK_TIMEOUT_MS = 1000
const RTK_BINARY = process.platform === 'win32' ? 'rtk.exe' : 'rtk'
const RTK_MAX_ATTEMPTS = 3
const RTK_RETRY_BACKOFF_MS = [50, 100] as const

export type RtkConfig = {
  path: string
}

/**
 * Why an `error` outcome can happen — surfaced so the caller can pick a
 * useful warning message instead of always claiming the binary is missing.
 */
export type RtkErrorReason =
  | 'binary-missing'    // resolver returned null — rtk[.exe] not found
  | 'spawn-failed'      // OS rejected the spawn (ENOENT/EBUSY/EPERM/...)
  | 'timeout'           // hit RTK_TIMEOUT_MS, or upstream abort signal
  | 'unexpected-exit'   // numeric exit code we don't know how to interpret
  | 'empty-output'      // exit 0 or 3 but stdout was blank

export type RtkRewriteResult =
  | { kind: 'rewrite'; cmd: string }
  | { kind: 'ask'; cmd: string }
  | { kind: 'passthrough' }
  | { kind: 'deny' }
  | { kind: 'error'; reason: RtkErrorReason; attempts: number }

/**
 * Find the bundled rtk binary. Two layouts, mirroring findBundledRipgrep
 * in utils/ripgrep.ts:
 *
 *   1. Packaged Bun-compiled exe (`isInBundledMode()` true): rtk[.exe]
 *      sits next to axiomate.exe — package-{win,mac,linux}.ts copy it
 *      there. Resolve via dirname(process.execPath). MUST come first
 *      because the require() fallback below fails inside Bun-compiled
 *      exes (their virtual fs has no node_modules).
 *
 *   2. Bun-runtime / pnpm install: process.execPath is bun.exe or
 *      node.exe — not useful. Resolve rtk-axiomate as a workspace
 *      package via createRequire(import.meta.url). The package's
 *      index.js exports `rtkPath` pointing at its bin/ entry.
 *
 * Both paths are derived from runtime values — no build-machine
 * absolute paths baked into the bundle.
 */
function findRtkBinary(): string | null {
  if (isInBundledMode()) {
    const candidate = join(dirname(process.execPath), RTK_BINARY)
    if (existsSync(candidate)) return candidate
  }
  try {
    const req = createRequire(import.meta.url)
    const mod = req('rtk-axiomate') as { rtkPath?: string | null }
    if (mod.rtkPath && existsSync(mod.rtkPath)) return mod.rtkPath
  } catch {
    // rtk-axiomate workspace not installed, or we're running from a
    // Bun-compiled exe whose virtual fs has no node_modules.
  }
  return null
}

/**
 * Resolve the rtk binary fresh on every call. NOT memoized — see commit
 * fdd2d81e for why (mid-session recovery when binary returns).
 */
export function getRtkConfig(): RtkConfig | null {
  const path = findRtkBinary()
  if (!path) {
    logForDebugging(
      `rtk not found — checked dirname(execPath)=${dirname(process.execPath)} and rtk-axiomate package`,
    )
    return null
  }
  logForDebugging(`rtk ready (path=${path})`)
  return { path }
}

function quoteIfNeeded(p: string): string {
  // Normalize Windows backslashes to forward slashes — bash on Windows
  // (git-bash) treats `\p` `\w` etc as escape sequences inside double
  // quotes, mangling C:\public\...\rtk.exe. Forward slashes are accepted
  // by both bash and cmd.exe on Windows, and unchanged on Unix.
  const normalized = p.replace(/\\/g, '/')
  if (!/[\s"]/.test(normalized)) return normalized
  return `"${normalized.replace(/"/g, '\\"')}"`
}

/**
 * The rewritten command starts with the bare token `rtk`. If our binary lives
 * next to axiomate.exe (bundled mode), the shell can't find it on PATH —
 * substitute the absolute path for the leading token. Also inject --quiet
 * so the second rtk invocation (the one bash actually runs) doesn't emit
 * a hook-not-installed warning to the user's terminal.
 */
function patchRewrittenCommand(rewritten: string, rtkPath: string): string {
  const trimmed = rewritten.trimEnd()
  if (!trimmed.startsWith('rtk')) return trimmed
  const after = trimmed.slice(3)
  if (after.length > 0 && !/\s/.test(after[0]!)) return trimmed
  return `${quoteIfNeeded(rtkPath)} --quiet${after}`
}

type AttemptOutcome =
  | { kind: 'rewrite'; cmd: string }
  | { kind: 'ask'; cmd: string }
  | { kind: 'passthrough' }
  | { kind: 'deny' }
  | { kind: 'error'; reason: RtkErrorReason; transient: boolean }

/**
 * Single attempt at `rtk rewrite <cmd>`. Maps the exit-code protocol
 * (rtk/src/hooks/rewrite_cmd.rs:7-17) to an outcome and tags errors with
 * a reason so callers can decide whether to retry.
 *
 * "transient" classification:
 *   - spawn-failed, timeout, empty-output → likely retryable (AV scan,
 *     cold-cache, transient OS state)
 *   - unexpected-exit → NOT retryable (rtk panicked or hit a bug; same
 *     input + same binary will hit the same path)
 */
function runRtkOnce(
  rtkPath: string,
  cmd: string,
  abortSignal: AbortSignal,
): Promise<AttemptOutcome> {
  return new Promise<AttemptOutcome>(resolve => {
    let settled = false
    const settle = (result: AttemptOutcome) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const child = execFile(
      rtkPath,
      // --quiet suppresses rtk's "No hook installed" advisory on stderr.
      // axiomate doesn't use Claude Code's hook pipeline (we call rewrite
      // directly via execFile), so that warning is misleading for our
      // users — and stderr can leak through BashTool's exec of the
      // rewritten command (`rtk <cmd>`), surfacing as red text in the
      // user's terminal. Requires rtk >= axiomate-v0.40.0+2.
      ['--quiet', 'rewrite', cmd],
      {
        timeout: RTK_TIMEOUT_MS,
        signal: abortSignal,
        encoding: 'utf-8',
        maxBuffer: 1_000_000,
        windowsHide: true,
      },
      (error, stdout) => {
        const stdoutPreview = JSON.stringify(stdout ?? '').slice(0, 200)
        if (error) {
          const err = error as NodeJS.ErrnoException & {
            signal?: string | null
          }
          logForDebugging(
            `[rtk-trace] attempt error: code=${JSON.stringify(err.code)} signal=${JSON.stringify(err.signal ?? null)} message=${JSON.stringify(err.message).slice(0, 200)} stdout=${stdoutPreview}`,
          )
          if (typeof err.code !== 'number') {
            // String code: ENOENT, EBUSY, EPERM, etc. Spawn-side failure.
            return settle({ kind: 'error', reason: 'spawn-failed', transient: true })
          }
          if (err.signal != null) {
            // Timeout or abort. execFile sets signal on timeout
            // (SIGTERM by default) and on AbortSignal.
            return settle({ kind: 'error', reason: 'timeout', transient: true })
          }
          const exitCode = err.code as number
          const rewritten = typeof stdout === 'string' ? stdout.trim() : ''
          switch (exitCode) {
            case 1:
              return settle({ kind: 'passthrough' })
            case 2:
              return settle({ kind: 'deny' })
            case 3:
              if (!rewritten) {
                return settle({ kind: 'error', reason: 'empty-output', transient: true })
              }
              return settle({
                kind: 'ask',
                cmd: patchRewrittenCommand(rewritten, rtkPath),
              })
            default:
              // rtk shouldn't return other numeric codes; treat as a bug,
              // not a transient hiccup, so we don't waste retries.
              return settle({ kind: 'error', reason: 'unexpected-exit', transient: false })
          }
        }
        // Exit 0: rewrite found, allowed.
        const rewritten = typeof stdout === 'string' ? stdout.trim() : ''
        if (!rewritten) {
          logForDebugging(`[rtk-trace] attempt exit=0 but stdout empty`)
          return settle({ kind: 'error', reason: 'empty-output', transient: true })
        }
        settle({
          kind: 'rewrite',
          cmd: patchRewrittenCommand(rewritten, rtkPath),
        })
      },
    )

    child.on('error', () => {
      // execFile already surfaces this through the callback as well, but
      // child.on('error') can fire before the callback in rare cases;
      // settled-latch keeps both paths idempotent.
      settle({ kind: 'error', reason: 'spawn-failed', transient: true })
    })
  })
}

/**
 * Invoke `rtk rewrite <cmd>` with up to RTK_MAX_ATTEMPTS tries.
 *
 * Retries on transient failures only — spawn errors (AV scan races, file
 * lock), timeouts (cold spawn on slow machines), and empty stdout. Does
 * NOT retry on unexpected-exit (rtk panic) or on success/passthrough/deny
 * outcomes, which are all definitive.
 *
 * Fail-open: when all attempts are exhausted, returns `kind: 'error'` so
 * the caller runs the original command unchanged.
 */
export async function rtkRewrite(
  cmd: string,
  abortSignal: AbortSignal,
): Promise<RtkRewriteResult> {
  const config = getRtkConfig()
  if (!config) {
    logForDebugging(
      `[rtk-trace] rtkRewrite: no config (resolver returned null), cmd=${JSON.stringify(cmd).slice(0, 200)}`,
    )
    return { kind: 'error', reason: 'binary-missing', attempts: 0 }
  }
  logForDebugging(
    `[rtk-trace] rtkRewrite: invoking ${config.path} rewrite <cmd> where cmd=${JSON.stringify(cmd).slice(0, 200)}`,
  )

  let lastReason: RtkErrorReason = 'spawn-failed'
  for (let attempt = 1; attempt <= RTK_MAX_ATTEMPTS; attempt++) {
    if (abortSignal.aborted) {
      return { kind: 'error', reason: 'timeout', attempts: attempt - 1 }
    }
    const outcome = await runRtkOnce(config.path, cmd, abortSignal)
    if (outcome.kind !== 'error') {
      if (attempt > 1) {
        logForDebugging(
          `[rtk-trace] rtkRewrite recovered on attempt ${attempt} with kind=${outcome.kind}`,
        )
      }
      return outcome
    }
    lastReason = outcome.reason
    if (!outcome.transient) {
      logForDebugging(
        `[rtk-trace] rtkRewrite giving up after attempt ${attempt}: non-transient reason=${outcome.reason}`,
      )
      return { kind: 'error', reason: outcome.reason, attempts: attempt }
    }
    if (attempt < RTK_MAX_ATTEMPTS) {
      const backoff = RTK_RETRY_BACKOFF_MS[attempt - 1] ?? 100
      logForDebugging(
        `[rtk-trace] rtkRewrite attempt ${attempt} failed (reason=${outcome.reason}), retrying after ${backoff}ms`,
      )
      await new Promise(resolve => setTimeout(resolve, backoff))
    }
  }
  logForDebugging(
    `[rtk-trace] rtkRewrite exhausted ${RTK_MAX_ATTEMPTS} attempts, last reason=${lastReason}`,
  )
  return { kind: 'error', reason: lastReason, attempts: RTK_MAX_ATTEMPTS }
}

/**
 * Human-readable warning text per failure reason. Used by BashTool to
 * surface a yellow ● bullet to the user. Phrased as one short sentence
 * so it fits the SystemTextMessage layout.
 */
export function rtkErrorWarning(reason: RtkErrorReason, attempts: number): string {
  const tries = attempts === 1 ? '1 try' : `${attempts} tries`
  switch (reason) {
    case 'binary-missing':
      return (
        'rtk is enabled in /config but the rtk binary was not found. ' +
        'Shell commands will run unfiltered. Place rtk next to axiomate, ' +
        'or disable the toggle to silence this warning.'
      )
    case 'spawn-failed':
      return (
        `rtk failed to start after ${tries} (likely antivirus or file-lock contention). ` +
        'Shell commands will run unfiltered for this turn.'
      )
    case 'timeout':
      return (
        `rtk timed out (>${RTK_TIMEOUT_MS}ms) on ${tries}. ` +
        'Shell commands will run unfiltered for this turn.'
      )
    case 'unexpected-exit':
      return (
        'rtk exited with an unexpected status — likely a bug. ' +
        'Shell commands will run unfiltered for this turn.'
      )
    case 'empty-output':
      return (
        `rtk returned empty output on ${tries} — possible version mismatch. ` +
        'Shell commands will run unfiltered for this turn.'
      )
  }
}
