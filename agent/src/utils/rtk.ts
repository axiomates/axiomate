import { execFile, execFileSync } from 'child_process'
import { existsSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { logForDebugging } from './debug.js'

const RTK_TIMEOUT_MS = 250
const RTK_BINARY = process.platform === 'win32' ? 'rtk.exe' : 'rtk'

export type RtkConfig = {
  path: string
}

export type RtkRewriteResult =
  | { kind: 'rewrite'; cmd: string }
  | { kind: 'ask'; cmd: string }
  | { kind: 'passthrough' }
  | { kind: 'deny' }
  | { kind: 'error' }

function probeRtk(command: string): boolean {
  try {
    const stdout = execFileSync(command, ['--version'], {
      // 8s ceiling — rtk's `--version` is ~20ms in steady state, but the
      // first invocation (cold cache, history.db init, antivirus
      // first-touch) can stretch to a few seconds on Windows. Anything
      // past 8s indicates a wedged binary; treat as broken.
      timeout: 8000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return typeof stdout === 'string' && stdout.toLowerCase().startsWith('rtk ')
  } catch {
    return false
  }
}

/**
 * Find the bundled rtk binary. Two layouts handled, mirroring how
 * @vscode/ripgrep and the NAPI workspaces (`load-napi.js`) do it:
 *
 *   1. Bun-compiled exe — process.execPath is axiomate.exe itself, with
 *      rtk[.exe] copied next to it by package-{win,mac,linux}.ts. This
 *      branch MUST win first in the packaged case: bun's compiled exes
 *      have a virtual node_modules (B:/~BUN/root/) where require()
 *      lookups can't find the rtk-axiomate workspace.
 *
 *   2. Bun-runtime / pnpm install — process.execPath is bun.exe (or
 *      node), so dirname(execPath) is the bun install dir, not useful.
 *      Walk up from this file's URL via import.meta.url to the agent
 *      package, then ../rtk-axiomate/bin/rtk[.exe]. This is the same
 *      path pnpm symlinks into agent/node_modules/rtk-axiomate, so the
 *      result matches what `require('rtk-axiomate').rtkPath` returns
 *      in non-bundled mode — only without going through require (which
 *      doesn't work in the packaged exe).
 */
function findRtkBinary(): string | null {
  const candidates: string[] = []

  // 1. Next to the executable (packaged-exe layout).
  candidates.push(join(dirname(process.execPath), RTK_BINARY))

  // 2. Workspace layout: <repo>/rtk-axiomate/bin/<binary>. Resolve from
  //    import.meta.url so we don't hardcode a build-machine path; this
  //    works whenever the source tree is checked out (dev / CI / pnpm
  //    consumer with hoisted layout).
  try {
    const here = fileURLToPath(import.meta.url) // agent/src/utils/rtk.ts (or dist/cli.js when bundled)
    // dist/cli.js is at agent/dist/cli.js → ../../rtk-axiomate; agent/src/utils/rtk.ts → ../../../rtk-axiomate.
    // Just probe both depths.
    const agentDir = here.includes(`${'dist'}${process.platform === 'win32' ? '\\' : '/'}cli.js`)
      ? dirname(dirname(here))
      : dirname(dirname(dirname(dirname(here))))
    const repoRoot = dirname(agentDir)
    candidates.push(join(repoRoot, 'rtk-axiomate', 'bin', RTK_BINARY))
  } catch {
    // import.meta.url not resolvable to a filesystem path (e.g. bun
    // virtual path B:/~BUN/root/...). Fine — candidate 1 already
    // covered the packaged case.
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export const getRtkConfig = memoize((): RtkConfig | null => {
  const path = findRtkBinary()
  if (!path) {
    logForDebugging(
      'rtk not found — run pnpm bootstrap to fetch the binary, or ensure rtk lives next to axiomate.exe in packaged builds',
    )
    return null
  }
  if (!probeRtk(path)) {
    logForDebugging(`rtk binary at ${path} failed --version probe`)
    return null
  }
  logForDebugging(`rtk ready (path=${path})`)
  return { path }
})

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
 * substitute the absolute path for the leading token.
 */
function patchRewrittenCommand(rewritten: string, rtkPath: string): string {
  const trimmed = rewritten.trimEnd()
  if (!trimmed.startsWith('rtk')) return trimmed
  const after = trimmed.slice(3)
  if (after.length > 0 && !/\s/.test(after[0]!)) return trimmed
  return `${quoteIfNeeded(rtkPath)}${after}`
}

/**
 * Invoke `rtk rewrite <cmd>` and map the exit-code protocol
 * (see rtk/src/hooks/rewrite_cmd.rs:7-17) to a discriminated result.
 *
 * Fail-open: any error (missing binary, timeout, unexpected exit code,
 * malformed output) returns `error` so the caller can run the original
 * command unchanged.
 */
export async function rtkRewrite(
  cmd: string,
  abortSignal: AbortSignal,
): Promise<RtkRewriteResult> {
  const config = getRtkConfig()
  if (!config) {
    logForDebugging(`[rtk-trace] rtkRewrite: no config (resolver returned null), cmd=${JSON.stringify(cmd).slice(0, 200)}`)
    return { kind: 'error' }
  }
  logForDebugging(`[rtk-trace] rtkRewrite: invoking ${config.path} rewrite <cmd> where cmd=${JSON.stringify(cmd).slice(0, 200)}`)

  return new Promise<RtkRewriteResult>(resolve => {
    let settled = false
    const settle = (result: RtkRewriteResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const child = execFile(
      config.path,
      ['rewrite', cmd],
      {
        timeout: RTK_TIMEOUT_MS,
        signal: abortSignal,
        encoding: 'utf-8',
        maxBuffer: 1_000_000,
        windowsHide: true,
      },
      (error, stdout) => {
        logForDebugging(`[rtk-trace] rtkRewrite callback: error=${error ? JSON.stringify({ code: (error as NodeJS.ErrnoException).code, signal: (error as NodeJS.ErrnoException & {signal?: string|null}).signal, message: error.message }) : 'null'} stdout=${JSON.stringify(stdout).slice(0, 200)}`)
        // execFile surfaces non-zero exits as an error whose `code` is the
        // numeric exit code. Spawn failures use string codes ('ENOENT' etc.),
        // and timeouts/aborts set `error.signal`. Fail open on anything that
        // isn't a clean numeric exit.
        if (error) {
          const err = error as NodeJS.ErrnoException & {
            signal?: string | null
          }
          if (typeof err.code !== 'number') {
            return settle({ kind: 'error' })
          }
          if (err.signal && err.signal !== null) {
            return settle({ kind: 'error' })
          }
          const exitCode = err.code as number
          const rewritten = typeof stdout === 'string' ? stdout.trim() : ''
          switch (exitCode) {
            case 1:
              return settle({ kind: 'passthrough' })
            case 2:
              return settle({ kind: 'deny' })
            case 3:
              if (!rewritten) return settle({ kind: 'error' })
              return settle({
                kind: 'ask',
                cmd: patchRewrittenCommand(rewritten, config.path),
              })
            default:
              return settle({ kind: 'error' })
          }
        }
        // Exit 0: rewrite found, allowed.
        const rewritten = typeof stdout === 'string' ? stdout.trim() : ''
        if (!rewritten) return settle({ kind: 'error' })
        settle({
          kind: 'rewrite',
          cmd: patchRewrittenCommand(rewritten, config.path),
        })
      },
    )

    child.on('error', () => settle({ kind: 'error' }))
  })
}
