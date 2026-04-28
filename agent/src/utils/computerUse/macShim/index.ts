/**
 * macOS native shim layer — barrel exports.
 *
 * Replaces `computer-use-native-axiomate` (deleted in Phase D2). Mac path's
 * loader code (`swiftLoader.ts`, `inputLoader.ts`) imports from here
 * instead of from a workspace package; symmetric with the Win path's
 * `winFallbacks.ts` (which agent also owns directly).
 *
 * What's inside:
 *   - `swiftShim.ts` (`createComputerUseSwift`) — wraps mac NAPI's
 *     hide/unhide/activate/Esc-hotkey/SCContentFilter calls and falls back
 *     to node-screenshots / osascript when the NAPI binding isn't loaded
 *   - `inputShim.ts` (`createComputerUseInput`) — wraps nut.js for mac
 *     keyboard / mouse (used by mac's createCliExecutor)
 *   - `nodeScreenshots.ts` — node-screenshots primitives (display info,
 *     full-screen / region capture)
 *   - `nutInput.ts` — @nut-tree-fork/nut-js wrapper (mac's input layer;
 *     Win path uses Win NAPI SendInput direct, doesn't touch this)
 *   - `osascriptApps.ts` — AppleScript / mdfind / plutil snippets for app
 *     enumeration on mac
 *   - `types.ts` — `ComputerUseAPI` / `ComputerUseInputAPI` interface defs
 */

export { createComputerUseSwift } from './swiftShim.js'
export { createComputerUseInput } from './inputShim.js'
export type { ComputerUseAPI, ComputerUseInput, ComputerUseInputAPI } from './types.js'
