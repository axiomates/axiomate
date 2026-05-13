/**
 * Example: session management without spawning the CLI.
 *
 * These functions read and mutate JSONL session files under
 * `~/.axiomate/projects/<sanitized-cwd>/` directly. No subprocess is
 * started — they're fast enough to call from UIs or analysis scripts.
 *
 * Run:
 *   pnpm run build && pnpm run sessions
 *
 * Set AXIOMATE_CONFIG_DIR to point at a non-default config root if you
 * want to test against an isolated dataset.
 */

import {
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  renameSession,
  tagSession,
} from 'axiomate-sdk'

async function main() {
  // 1. List sessions across all projects.
  console.log('All sessions (most recent first):')
  const recent = await listSessions({ limit: 5 })
  if (recent.length === 0) {
    console.log('  (none yet — run axiomate to create one, then try again)')
    return
  }

  for (const s of recent) {
    const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '?'
    const title = s.title ?? '(untitled)'
    const tag = s.tag ? ` [${s.tag}]` : ''
    console.log(`  ${s.id.slice(0, 8)}  ${when}  ${title}${tag}`)
  }

  // 2. List sessions scoped to a specific project directory.
  console.log('\nSessions in cwd:')
  const here = await listSessions({ dir: process.cwd(), limit: 3 })
  for (const s of here) {
    console.log(`  ${s.id.slice(0, 8)}  ${s.title ?? '(untitled)'}`)
  }

  if (recent.length === 0) return
  const target = recent[0]!

  // 3. Read metadata for a single session — cheaper than listSessions().
  console.log(`\nMetadata for ${target.id.slice(0, 8)}:`)
  const info = await getSessionInfo(target.id)
  console.log(JSON.stringify(info, null, 2))

  // 4. Stream the conversation transcript.
  console.log(`\nFirst few messages of ${target.id.slice(0, 8)}:`)
  const messages = await getSessionMessages(target.id, { limit: 3 })
  for (const m of messages) {
    const preview = JSON.stringify(m.content).slice(0, 80)
    console.log(`  [${m.type}] ${preview}`)
  }

  // 5. Demo mutations on a temporary fork to avoid clobbering the original.
  if (process.argv.includes('--mutate')) {
    console.log(`\nForking ${target.id.slice(0, 8)}...`)
    const fork = await forkSession(target.id, { title: 'SDK example fork' })
    console.log(`  fork sessionId: ${fork.sessionId}`)

    await renameSession(fork.sessionId, `Renamed at ${new Date().toISOString()}`)
    console.log(`  renamed.`)

    await tagSession(fork.sessionId, 'demo')
    console.log(`  tagged "demo".`)

    const forkInfo = await getSessionInfo(fork.sessionId)
    console.log(`  fork metadata:`)
    console.log(JSON.stringify(forkInfo, null, 2))
  } else {
    console.log('\nPass --mutate to also demo forkSession / renameSession / tagSession.')
  }
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
