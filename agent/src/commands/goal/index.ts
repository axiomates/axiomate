import type { Command } from '../../commands.js'

const goal = {
  type: 'local-jsx',
  name: 'goal',
  description:
    'Set / inspect a persistent cross-turn goal. After each turn a judge model decides whether the goal is done and re-queues a continuation otherwise.',
  argumentHint: '[<text> | status | pause | resume | clear]',
  // Pure local op (state read/write + at most one enqueue) — no LLM
  // call. Runs even while a goal-loop turn is in flight so users can
  // /goal status / pause / clear without waiting for the current turn.
  immediate: true,
  load: () => import('./goal.js'),
} satisfies Command

export default goal
