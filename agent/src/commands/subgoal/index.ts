import type { Command } from '../../commands.js'

const subgoal = {
  type: 'local-jsx',
  name: 'subgoal',
  description: 'List / add / remove subgoals for the active /goal',
  argumentHint: '[<text> | list | remove <n> | clear]',
  // Pure local op — runs immediately even while the goal loop is
  // executing a turn (matching hermes cli.py:9374-9395, where adding a
  // /subgoal mid-loop does not block the running turn).
  immediate: true,
  load: () => import('./subgoal.js'),
} satisfies Command

export default subgoal
