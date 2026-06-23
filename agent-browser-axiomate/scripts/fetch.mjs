#!/usr/bin/env node
/**
 * Fetch the agent-browser CLI binary for the HOST platform from
 * vercel-labs/agent-browser GitHub releases, mirroring rtk-axiomate's
 * scripts/fetch.mjs (cache → offline fallback → fail-soft).
 *
 * DIFFERENCE FROM rtk: the version is PINNED (not "latest"). agent-browser
 * is a third-party repo we don't control, so an unattended "latest" could
 * pull a breaking change or an unverified build into our shipped product.
 * AGENT_BROWSER_VERSION below is the version we've actually tested
 * (connectOverCDP to the launcher's local Chrome verified on 2026-06-10 for
 * v0.27.1; re-verified the same path + the 26-tool subcommand contract on
 * 2026-06-19 when bumping to v0.28.0; bumped to v0.29.0 on 2026-06-23 — the
 * v0.28.0..v0.29.0 range touched NO CLI contract file we depend on (only a
 * new, unused Vercel Sandbox package), re-verified by real Chrome smoke).
 * Bump it deliberately after re-testing.
 *
 * Release assets are bare binaries (e.g. `agent-browser-win32-x64.exe`),
 * not archives — no extraction step. We download and normalize the name to
 * `agent-browser` / `agent-browser.exe` so index.js's resolver is
 * platform-suffix-agnostic.
 *
 * Fail-soft: on download failure with no usable cache, prints a warning and
 * exits 0. The runtime resolver disables the browser-bridge feature silently
 * when bin/ is empty.
 *
 * NO GITHUB API CALL (and so no auth/rate-limit handling, unlike
 * rtk-axiomate): because the version is PINNED we know the exact tag and asset
 * name up front, so we hit the release-DOWNLOAD endpoint directly
 * (github.com/.../releases/download/<tag>/<asset>). That endpoint is a plain
 * CDN-backed file fetch — it is NOT subject to the api.github.com 60-req/hr
 * unauthenticated rate limit that forced rtk-axiomate to authenticate. rtk
 * must call the API every build to resolve "latest"; we never do. If this repo
 * ever goes private, or we move to resolving "latest" dynamically, add the
 * same `githubToken()` auth helper rtk uses.
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const AGENT_BROWSER_REPO = 'vercel-labs/agent-browser'
// Pinned, tested version. See header comment before bumping.
const AGENT_BROWSER_VERSION = 'v0.29.0'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const asset = assetForHost()
if (!asset) {
  console.warn(
    `agent-browser-axiomate: unsupported platform ${process.platform}/${process.arch} — bundling skipped`,
  )
  process.exit(0)
}

// Stable on-disk name (no platform suffix) that index.js resolves.
const localBinary =
  process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser'
const binDir = join(packageDir, 'bin')
const binPath = join(binDir, localBinary)
const cacheRoot = join(packageDir, '.cache')
const cacheDir = join(cacheRoot, `${AGENT_BROWSER_VERSION}-${asset}`)
const cacheBinary = join(cacheDir, localBinary)

if (existsSync(cacheBinary)) {
  installFromCache(cacheBinary)
  pruneOtherCaches()
  console.log(`agent-browser-axiomate: reused cache ${AGENT_BROWSER_VERSION} (${asset})`)
  process.exit(0)
}

mkdirSync(cacheDir, { recursive: true })

if (!downloadAsset(AGENT_BROWSER_VERSION, asset, cacheBinary)) {
  // Pinned download failed (offline / rate-limited). Fall back to any cached
  // binary for this platform so an offline rebuild still works.
  rmSync(cacheDir, { recursive: true, force: true })
  const stale = findAnyCachedBinary()
  if (stale) {
    installFromCache(stale)
    console.log(`agent-browser-axiomate: GitHub unreachable, reused cached binary`)
    process.exit(0)
  }
  console.warn(
    `agent-browser-axiomate: failed to download ${asset} from ${AGENT_BROWSER_REPO}@${AGENT_BROWSER_VERSION} and no local cache — bundling skipped`,
  )
  process.exit(0)
}

if (process.platform !== 'win32') chmodSync(cacheBinary, 0o755)
installFromCache(cacheBinary)
pruneOtherCaches()
console.log(`agent-browser-axiomate: fetched ${AGENT_BROWSER_VERSION} (${asset})`)

// ─────────────────────────────────────────────────────────────────────

function installFromCache(srcBinary) {
  mkdirSync(binDir, { recursive: true })
  copyFileSync(srcBinary, binPath)
  if (process.platform !== 'win32') chmodSync(binPath, 0o755)
}

/** Delete every `.cache/<other>` slot except the current version+asset. */
function pruneOtherCaches() {
  if (!existsSync(cacheRoot)) return
  const keep = `${AGENT_BROWSER_VERSION}-${asset}`
  for (const entry of readdirSync(cacheRoot)) {
    if (entry === keep) continue
    // Only prune slots for THIS platform asset so cross-compiled caches survive.
    if (!entry.endsWith(`-${asset}`)) continue
    try {
      rmSync(join(cacheRoot, entry), { recursive: true, force: true })
    } catch (e) {
      console.warn(`agent-browser-axiomate: failed to prune ${entry}: ${e.message}`)
    }
  }
}

function findAnyCachedBinary() {
  if (!existsSync(cacheRoot)) return null
  const suffix = `-${asset}`
  for (const entry of readdirSync(cacheRoot)) {
    if (!entry.endsWith(suffix)) continue
    const candidate = join(cacheRoot, entry, localBinary)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Map host platform/arch to the release ASSET FILENAME published by
 * vercel-labs/agent-browser (verified against v0.29.0 release assets; names
 * unchanged since v0.27.1 — v0.28.0 added linux-musl variants we don't use,
 * v0.29.0 added no new platform assets).
 */
function assetForHost() {
  const { platform, arch } = process
  if (platform === 'win32' && arch === 'x64') return 'agent-browser-win32-x64.exe'
  if (platform === 'darwin' && arch === 'arm64') return 'agent-browser-darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'agent-browser-darwin-x64'
  if (platform === 'linux' && arch === 'x64') return 'agent-browser-linux-x64'
  if (platform === 'linux' && arch === 'arm64') return 'agent-browser-linux-arm64'
  return null
}

function downloadAsset(version, assetName, destFile) {
  const url = `https://github.com/${AGENT_BROWSER_REPO}/releases/download/${version}/${assetName}`
  const result = spawnSync(
    'curl',
    [
      '--silent', '--show-error', '--fail', '--location',
      '--retry', '3', '--retry-delay', '2',
      '--max-time', '120',
      '--output', destFile,
      url,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  )
  return result.status === 0 && existsSync(destFile)
}
