/**
 * Example: cron scheduler integration.
 *
 * Watches `<dir>/.axiomate/scheduled_tasks.json` and yields events as
 * tasks fire. Demonstrates:
 *   - acquiring the per-directory scheduler lock
 *   - draining fire/missed events with for-await-of
 *   - getNextFireTime() for daemons that want to suspend until imminent fires
 *   - clean teardown via AbortSignal
 *
 * Run:
 *   pnpm run build && pnpm run scheduler
 *
 * To see fire events:
 *   1. Run this script.
 *   2. In another terminal, write a task to the file:
 *
 *      mkdir -p .axiomate
 *      cat > .axiomate/scheduled_tasks.json <<'EOF'
 *      {
 *        "tasks": [
 *          { "id": "demo0001", "cron": "* * * * *", "prompt": "every minute", "createdAt": 0, "recurring": true }
 *        ]
 *      }
 *      EOF
 *
 *   3. Wait for the next minute boundary.
 */

import {
  buildMissedTaskNotification,
  watchScheduledTasks,
  writeCronTasks,
} from 'axiomate-sdk'

async function main() {
  const dir = process.argv[2] ?? process.cwd()
  console.log(`Watching ${dir}/.axiomate/scheduled_tasks.json`)
  console.log('(Ctrl-C to stop)\n')

  const ac = new AbortController()
  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    ac.abort()
  })

  // Optional: seed a one-shot task to demonstrate firing. Uncomment to use.
  if (process.argv.includes('--seed-recurring')) {
    await writeCronTasks(
      [
        {
          id: 'demoseed',
          cron: '* * * * *',
          prompt: 'Hello from the scheduler!',
          createdAt: Date.now(),
          recurring: true,
        },
      ],
      dir,
    )
    console.log('Seeded a recurring "* * * * *" task. Will fire at the next whole minute.\n')
  }

  const handle = watchScheduledTasks({ dir, signal: ac.signal })

  // Print the next imminent fire time once a second so you can see the schedule.
  const ticker = setInterval(() => {
    const next = handle.getNextFireTime()
    if (next !== null) {
      const inMs = next - Date.now()
      const mins = Math.floor(inMs / 60_000)
      const secs = Math.floor((inMs % 60_000) / 1000)
      process.stdout.write(`\r⏱  next fire in ${mins}m${secs}s `)
    }
  }, 1000)

  try {
    for await (const event of handle.events()) {
      if (event.type === 'fire') {
        console.log(`\n🔥 fire: [${event.task.id}] ${event.task.prompt}`)
        console.log(`   cron=${event.task.cron} recurring=${event.task.recurring ?? false}`)
        // In a real daemon, you'd hand `event.task.prompt` off to query()
        // here to actually run the agent against it.
      } else if (event.type === 'missed') {
        console.log('\n⚠  missed tasks while we were offline:')
        console.log(buildMissedTaskNotification(event.tasks))
      }
    }
  } finally {
    clearInterval(ticker)
    console.log('\nScheduler stopped.')
  }
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
