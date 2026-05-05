/**
 * Per-process `ComputerUseSessionContext` builder + per-call `ToolUseContext`
 * bridge. Used by `mcpServer.ts` (in-process MCP server factory) — the server
 * holds the ctx in its `bindSessionContext` closure (lastScreenshot blob,
 * etc.) for the process lifetime, and `client.ts` updates the per-call ref
 * before each callTool so dialog/abort/notification callbacks see the right
 * `ToolUseContext`.
 */

import { type ComputerUseSessionContext, type CuPermissionRequest, type CuPermissionResponse, DEFAULT_GRANT_FLAGS, type ScreenshotDims } from 'computer-use-mcp-axiomate';
import * as React from 'react';
import { getSessionId } from '../../bootstrap/state.js';
import { ComputerUseApproval } from '../../components/permissions/ComputerUseApproval/ComputerUseApproval.js';
import type { ToolUseContext } from '../../Tool.js';
import { logForDebugging } from '../debug.js';
import { checkComputerUseLock, tryAcquireComputerUseLock } from './computerUseLock.js';
import { registerEscHotkey } from './escHotkey.js';

/**
 * `currentToolUseContext` is updated on every CallTool. Every getter/callback
 * in `ctx` reads through it, so the per-call pieces (`abortController`,
 * `setToolJSX`, `sendOSNotification`) are always current.
 *
 * Module-level `let` is a deliberate exception to the no-module-scope-state
 * rule (src/AXIOMATE.md): the in-process server's `bindSessionContext` closure
 * must persist across calls so its internal screenshot blob survives, but
 * `ToolUseContext` is per-call. Tests inject by setting/restoring this.
 */
let currentToolUseContext: ToolUseContext | undefined;
function tuc(): ToolUseContext {
  // Safe: only read inside `ctx` callbacks, which fire from the in-process
  // MCP server CallTool handler — client.ts sets currentToolUseContext
  // immediately before invoking client.callTool().
  return currentToolUseContext!;
}

/**
 * Set the per-call `ToolUseContext` ref. Called by client.ts in the
 * in-process MCP path before forwarding callTool to the server.
 */
export function setCurrentToolUseContext(ctx: ToolUseContext): void {
  currentToolUseContext = ctx;
}
function formatLockHeld(holder: string): string {
  return `Computer use is in use by another Axiomate session (${holder.slice(0, 8)}…). Wait for that session to finish or run /exit there.`;
}
export function buildSessionContext(): ComputerUseSessionContext {
  return {
    // ── Read state fresh via the per-call ref ─────────────────────────────
    getAllowedApps: () => tuc().getAppState().computerUseMcpState?.allowedApps ?? [],
    // Win: no request_access flow → no way to flip grant flags via UI.
    // Default-open mode (consistent with allowlist gates) auto-grants all
    // three flags so AI can use read_clipboard / write_clipboard / key with
    // system-level combos without a dead-end ceremony. Mac path keeps the
    // existing state-backed flow since ComputerUseApproval modal is the
    // user-visible grant ceremony there.
    getGrantFlags: () =>
      process.platform === 'win32'
        ? { clipboardRead: true, clipboardWrite: true, systemKeyCombos: true }
        : tuc().getAppState().computerUseMcpState?.grantFlags ?? DEFAULT_GRANT_FLAGS,
    // cc-2 has no Settings page for user-denied apps yet.
    getUserDeniedAppIdentifiers: () => [],
    getSelectedDisplayId: () => tuc().getAppState().computerUseMcpState?.selectedDisplayId,
    getDisplayPinnedByModel: () => tuc().getAppState().computerUseMcpState?.displayPinnedByModel ?? false,
    getDisplayResolvedForApps: () => tuc().getAppState().computerUseMcpState?.displayResolvedForApps,
    // ── Write-backs ────────────────────────────────────────────────────────
    // `setToolJSX` is guaranteed present — the gate in `main.tsx` excludes
    // non-interactive sessions. The package's `_dialogSignal` (tool-finished
    // dismissal) is irrelevant here: `setToolJSX` blocks the tool call, so
    // the dialog can't outlive it. Ctrl+C is what matters, and
    // `runPermissionDialog` wires that from the per-call ref's abortController.
    onPermissionRequest: (req, _dialogSignal) => runPermissionDialog(req),
    // Package does the merge (dedupe + truthy-only flags). We just persist.
    onAllowedAppsChanged: (apps, flags) => tuc().setAppState(prev => {
      const cu = prev.computerUseMcpState;
      const prevApps = cu?.allowedApps;
      const prevFlags = cu?.grantFlags;
      const sameApps = prevApps?.length === apps.length && apps.every((a, i) => prevApps[i]?.appIdentifier === a.appIdentifier);
      const sameFlags = prevFlags?.clipboardRead === flags.clipboardRead && prevFlags?.clipboardWrite === flags.clipboardWrite && prevFlags?.systemKeyCombos === flags.systemKeyCombos;
      return sameApps && sameFlags ? prev : {
        ...prev,
        computerUseMcpState: {
          ...cu,
          allowedApps: [...apps],
          grantFlags: flags
        }
      };
    }),
    onAppsHidden: ids => {
      if (ids.length === 0) return;
      tuc().setAppState(prev => {
        const cu = prev.computerUseMcpState;
        const existing = cu?.hiddenDuringTurn;
        if (existing && ids.every(id => existing.has(id))) return prev;
        return {
          ...prev,
          computerUseMcpState: {
            ...cu,
            hiddenDuringTurn: new Set([...(existing ?? []), ...ids])
          }
        };
      });
    },
    // Resolver writeback only fires under a pin when Swift fell back to main
    // (pinned display unplugged) — the pin is semantically dead, so clear it
    // and the app-set key so the chase chain runs next time. When autoResolve
    // was true, onDisplayResolvedForApps re-sets the key in the same tick.
    onResolvedDisplayUpdated: id => tuc().setAppState(prev => {
      const cu = prev.computerUseMcpState;
      if (cu?.selectedDisplayId === id && !cu.displayPinnedByModel && cu.displayResolvedForApps === undefined) {
        return prev;
      }
      return {
        ...prev,
        computerUseMcpState: {
          ...cu,
          selectedDisplayId: id,
          displayPinnedByModel: false,
          displayResolvedForApps: undefined
        }
      };
    }),
    // switch_display(name) pins; switch_display("auto") unpins and clears the
    // app-set key so the next screenshot auto-resolves fresh.
    onDisplayPinned: id => tuc().setAppState(prev => {
      const cu = prev.computerUseMcpState;
      const pinned = id !== undefined;
      const nextResolvedFor = pinned ? cu?.displayResolvedForApps : undefined;
      if (cu?.selectedDisplayId === id && cu?.displayPinnedByModel === pinned && cu?.displayResolvedForApps === nextResolvedFor) {
        return prev;
      }
      return {
        ...prev,
        computerUseMcpState: {
          ...cu,
          selectedDisplayId: id,
          displayPinnedByModel: pinned,
          displayResolvedForApps: nextResolvedFor
        }
      };
    }),
    onDisplayResolvedForApps: key => tuc().setAppState(prev => {
      const cu = prev.computerUseMcpState;
      if (cu?.displayResolvedForApps === key) return prev;
      return {
        ...prev,
        computerUseMcpState: {
          ...cu,
          displayResolvedForApps: key
        }
      };
    }),
    // ── Lock — async, direct file-lock calls ───────────────────────────────
    // No `lockHolderForGate` dance: the package's gate is async now. It
    // awaits `checkCuLock`, and on `holder: undefined` + non-deferring tool
    // awaits `acquireCuLock`. `defersLockAcquire` is the PACKAGE's set —
    // the local copy is gone.
    checkCuLock: async () => {
      const c = await checkComputerUseLock();
      switch (c.kind) {
        case 'free':
          return {
            holder: undefined,
            isSelf: false
          };
        case 'held_by_self':
          return {
            holder: getSessionId(),
            isSelf: true
          };
        case 'blocked':
          return {
            holder: c.by,
            isSelf: false
          };
      }
    },
    // Called only when checkCuLock returned `holder: undefined`. The O_EXCL
    // acquire is atomic — if another process grabbed it in the gap (rare),
    // throw so the tool fails instead of proceeding without the lock.
    // `fresh: false` (re-entrant) shouldn't happen given check said free,
    // but is possible under parallel tool-use interleaving — don't spam the
    // notification in that case.
    acquireCuLock: async () => {
      const r = await tryAcquireComputerUseLock();
      if (r.kind === 'blocked') {
        throw new Error(formatLockHeld(r.by));
      }
      if (r.fresh) {
        // Global Escape → abort. Consumes the event (PI defense — prompt
        // injection can't dismiss dialogs with Escape). escHotkey.ts
        // dispatches to the right platform impl: mac → CGEventTap via shim
        // (CFRunLoopSource pumped by drainRunLoop); win → WH_KEYBOARD_LL
        // via win NAPI directly (own worker thread + message pump). Either
        // way the OS notification copy reflects whether the hotkey actually
        // installed (false → user gets the Ctrl+C message instead).
        const escRegistered = registerEscHotkey(() => {
          logForDebugging('[cu-esc] user escape, aborting turn');
          tuc().abortController.abort();
        });
        tuc().sendOSNotification?.({
          message: escRegistered ? 'Axiomate is using your computer · press Esc to stop' : 'Axiomate is using your computer · press Ctrl+C to stop',
          notificationType: 'computer_use_enter'
        });
      }
    },
    formatLockHeldMessage: formatLockHeld,

    vlQuery: async (opts) => {
      const { getVlModel } = await import('../model/model.js')
      const { getProviderForModel } = await import('../../services/api/providerRegistry.js')
      const { sideQuery } = await import('../../services/api/capabilities/sideQuery.js')
      const model = getVlModel()
      const provider = getProviderForModel(model)

      type ContentBlockParam = import('../../services/api/streamTypes.js').ContentBlockParam
      const content: ContentBlockParam[] = []
      for (const img of opts.images) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: img },
        })
      }
      content.push({ type: 'text', text: opts.prompt })

      const response = await sideQuery(provider, {
        model,
        messages: [{ role: 'user', content }],
        maxTokens: 1024,
        querySource: 'computer_use_vl',
        ...(opts.schema ? { outputFormat: { type: 'json_schema', schema: opts.schema } } : {}),
      })

      const text = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('')

      let parsed: unknown = undefined
      if (opts.schema) {
        try { parsed = JSON.parse(text) } catch { /* VL might not return valid JSON */ }
      }

      return { text, parsed }
    },
  };
}
/**
 * Render the approval dialog mid-call via `setToolJSX` + `Promise`, wait for
 * the user. Mirrors `spawnMultiAgent.ts:419-436` (the `It2SetupPrompt` pattern).
 *
 * The merge-into-AppState that used to live here (dedupe + truthy-only flags)
 * is now in the package's `bindSessionContext` → `onAllowedAppsChanged`.
 */
async function runPermissionDialog(req: CuPermissionRequest): Promise<CuPermissionResponse> {
  const context = tuc();

  // bypassPermissions mode: auto-grant everything the AI requested without
  // showing the modal. Mirrors the tool-boundary bypass at
  // utils/permissions/permissions.ts:694-707, which only kicks in BEFORE
  // tool execution — `request_access` is itself a tool, so by the time it
  // runs and pops this dialog the boundary check has already passed and we
  // need a separate bypass at this mid-execution layer.
  //
  // Skipped apps (resolved=undefined, i.e. not installed) go to `denied`
  // with reason `not_installed` — same shape the modal would emit.
  const appState = context.getAppState();
  const mode = appState.toolPermissionContext.mode;
  const prePlanMode = appState.toolPermissionContext.prePlanMode;
  const shouldBypassPermissions =
    mode === 'bypassPermissions' ||
    (mode === 'plan' && prePlanMode === 'bypassPermissions');
  if (shouldBypassPermissions) {
    const now = Date.now();
    const granted = [];
    const denied: { appIdentifier: string; reason: 'user_denied' | 'not_installed' }[] = [];
    for (const app of req.apps) {
      if (!app.resolved) {
        denied.push({ appIdentifier: app.requestedName, reason: 'not_installed' });
        continue;
      }
      granted.push({
        appIdentifier: app.resolved.appIdentifier,
        displayName: app.resolved.displayName,
        grantedAt: now,
        tier: app.proposedTier,
      });
    }
    logForDebugging(
      `[computer-use] runPermissionDialog: bypassPermissions mode → auto-granting ${granted.length}/${req.apps.length} apps without modal (denied ${denied.length} not-installed)`,
      { level: 'warn' },
    );
    return {
      granted,
      denied,
      flags: {
        clipboardRead: true,
        clipboardWrite: true,
        systemKeyCombos: true,
      },
    };
  }

  const setToolJSX = context.setToolJSX;
  if (!setToolJSX) {
    // Shouldn't happen — main.tsx gate excludes non-interactive. Fail safe.
    return {
      granted: [],
      denied: [],
      flags: DEFAULT_GRANT_FLAGS
    };
  }
  try {
    return await new Promise<CuPermissionResponse>((resolve, reject) => {
      const signal = context.abortController.signal;
      // If already aborted, addEventListener won't fire — reject now so the
      // promise doesn't hang waiting for a user who Ctrl+C'd.
      if (signal.aborted) {
        reject(new Error('Computer Use permission dialog aborted'));
        return;
      }
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('Computer Use permission dialog aborted'));
      };
      signal.addEventListener('abort', onAbort);
      setToolJSX({
        jsx: React.createElement(ComputerUseApproval, {
          request: req,
          onDone: (resp: CuPermissionResponse) => {
            signal.removeEventListener('abort', onAbort);
            resolve(resp);
          }
        }),
        shouldHidePromptInput: true
      });
    });
  } finally {
    setToolJSX(null);
  }
}
