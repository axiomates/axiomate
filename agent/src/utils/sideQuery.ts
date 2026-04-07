/**
 * Backwards-compatibility re-export.
 *
 * All callers should import from `../services/api/capabilities/sideQuery.js`
 * directly and pass a provider as the first argument.
 *
 * This shim is kept so that any remaining transitive imports or test mocks
 * that reference `utils/sideQuery` continue to resolve.
 */
export { sideQuery, type NeutralSideQueryOptions } from '../services/api/capabilities/sideQuery.js'
