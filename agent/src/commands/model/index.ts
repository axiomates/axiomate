import type { Command } from '../../commands.js'
import { getMainLoopModel, renderModelName } from '../../utils/model/model.js'

export default {
  type: 'local-jsx',
  name: 'model',
  get description() {
    return `Manage model resources, routes, fallback chains, and auxiliary task policies (currently ${renderModelName(getMainLoopModel())})`
  },
  argumentHint:
    '[show | use <model-id> | add | edit <model-id> | route ... | default <route-id> | fallback ... | aux ...]',
  load: () => import('./model.js'),
} satisfies Command
