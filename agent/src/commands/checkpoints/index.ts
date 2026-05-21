import type { Command } from '../../commands.js'

const checkpoints = {
  type: 'local-jsx',
  name: 'checkpoints',
  description:
    'View / prune / clear the shadow checkpoint store (~/.axiomate/checkpoints/).',
  argumentHint: '[status|list|prune [--force]|clear]',
  load: () => import('./checkpoints.js'),
} satisfies Command

export default checkpoints
