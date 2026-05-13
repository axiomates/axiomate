/**
 * MCP server factory + session-context binder.
 *
 * Two entry points:
 *
 *   `bindSessionContext` — the wrapper closure. Takes a `ComputerUseSessionContext`
 *   (getters + callbacks backed by host session state), returns a dispatcher.
 *   Reusable by both the MCP CallTool handler here AND host-direct dispatchers
 *   that don't go through MCP. This consolidates what was previously duplicated
 *   wrapper closures in both the upstream Electron app's serverDef.ts and the
 *   CLI's CU host wrapper — both did the same thing: build `ComputerUseOverrides`
 *   fresh from getters, call `handleToolCall`, stash screenshot, merge permissions.
 *
 *   `createComputerUseMcpServer` — the Server object. When `context` is provided,
 *   the CallTool handler is real (uses `bindSessionContext`). When not, it's the
 *   legacy stub that returns a not-wired error. The tool-schema ListTools handler
 *   is the same either way.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { ScreenshotResult } from "./executor.js";
import type { CuCallToolResult } from "./toolCalls.js";
import {
  defersLockAcquire,
  handleToolCall,
  resetMouseButtonHeld,
} from "./toolCalls.js";
import { buildComputerUseTools } from "./tools.js";
import type {
  AppGrant,
  ComputerUseHostAdapter,
  ComputerUseOverrides,
  ComputerUseSessionContext,
  CoordinateMode,
  CuGrantFlags,
  CuPermissionRequest,
  CuPermissionResponse,
  CuTeachPermissionRequest,
} from "./types.js";
import { allowedAppsOf, DEFAULT_GRANT_FLAGS } from "./types.js";

const DEFAULT_LOCK_HELD_MESSAGE =
  "Another Axiomate session is currently using the computer. Wait for that " +
  "session to finish, or find a non-computer-use approach.";

/**
 * Dedupe `granted` into `existing` on appIdentifier, spread truthy-only flags over
 * defaults+existing. Truthy-only: a subsequent `request_access` that doesn't
 * request clipboard can't revoke an earlier clipboard grant — revocation lives
 * in a Settings page, not here.
 *
 * Same merge both hosts implemented independently today.
 */
function mergePermissionResponse(
  existing: readonly AppGrant[],
  existingFlags: CuGrantFlags,
  response: CuPermissionResponse,
): { apps: AppGrant[]; flags: CuGrantFlags } {
  const seen = new Set(existing.map((a) => a.appIdentifier));
  const apps = [
    ...existing,
    ...response.granted.filter((g) => !seen.has(g.appIdentifier)),
  ];
  const truthyFlags = Object.fromEntries(
    Object.entries(response.flags).filter(([, v]) => v === true),
  );
  const flags: CuGrantFlags = {
    ...DEFAULT_GRANT_FLAGS,
    ...existingFlags,
    ...truthyFlags,
  };
  return { apps, flags };
}

/**
 * Bind session state to a reusable dispatcher. The returned function is the
 * wrapper closure: async lock gate → build overrides fresh → `handleToolCall`
 * → stash screenshot → strip piggybacked fields.
 *
 * The last-screenshot blob is held in a closure cell here (not on `ctx`), so
 * hosts don't need to guarantee `ctx` object identity across calls — they just
 * need to hold onto the returned dispatcher. The upstream Electron app caches
 * per-session in a WeakMap; the CLI host constructs once at server creation.
 */
export function bindSessionContext(
  adapter: ComputerUseHostAdapter,
  coordinateMode: CoordinateMode,
  ctx: ComputerUseSessionContext,
): (name: string, args: unknown) => Promise<CuCallToolResult> {
  const { logger, serverName } = adapter;

  // Locate loop state — set by vision_locate, cleared by accept.
  let activeLocate: import("./clickTarget.js").LocateState | null = null;
  let lastZoomMarks: import("./clickTarget.js").Mark[] = [];

  const wrapPermission = ctx.onPermissionRequest
    ? async (
        req: Parameters<NonNullable<typeof ctx.onPermissionRequest>>[0],
        signal: AbortSignal,
      ): Promise<CuPermissionResponse> => {
        const response = await ctx.onPermissionRequest!(req, signal);
        const { apps, flags } = mergePermissionResponse(
          ctx.getAllowedApps(),
          ctx.getGrantFlags(),
          response,
        );
        logger.debug(
          `[${serverName}] permission result: granted=${response.granted.length} denied=${response.denied.length}`,
        );
        ctx.onAllowedAppsChanged?.(apps, flags);
        return response;
      }
    : undefined;

  const wrapTeachPermission = ctx.onTeachPermissionRequest
    ? async (
        req: Parameters<NonNullable<typeof ctx.onTeachPermissionRequest>>[0],
        signal: AbortSignal,
      ): Promise<CuPermissionResponse> => {
        const response = await ctx.onTeachPermissionRequest!(req, signal);
        logger.debug(
          `[${serverName}] teach permission result: granted=${response.granted.length} denied=${response.denied.length}`,
        );
        // Teach doesn't request grant flags — preserve existing.
        const { apps } = mergePermissionResponse(
          ctx.getAllowedApps(),
          ctx.getGrantFlags(),
          response,
        );
        ctx.onAllowedAppsChanged?.(apps, {
          ...DEFAULT_GRANT_FLAGS,
          ...ctx.getGrantFlags(),
        });
        return response;
      }
    : undefined;

  function canSuggestVisionLocate(): boolean {
    return (
      adapter.isVisionLocateEnabled() &&
      adapter.currentModelSupportsImages()
    );
  }

  return async (name, args) => {
    // ─── Async lock gate ─────────────────────────────────────────────────
    // Replaces the sync Gate-3 in `handleToolCall` — we pass
    // `checkCuLock: undefined` below so it no-ops. Hosts with
    // cross-process locks (O_EXCL file) await the real primitive here
    // instead of pre-computing + feeding a fake sync result.
    if (ctx.checkCuLock) {
      const lock = await ctx.checkCuLock();
      if (lock.holder !== undefined && !lock.isSelf) {
        const text =
          ctx.formatLockHeldMessage?.(lock.holder) ?? DEFAULT_LOCK_HELD_MESSAGE;
        return {
          content: [{ type: "text", text }],
          isError: true,
          telemetry: { error_kind: "cu_lock_held" },
        };
      }
      if (lock.holder === undefined && !defersLockAcquire(name)) {
        await ctx.acquireCuLock?.();
        // Re-check: the awaits above yield the microtask queue, so another
        // session's check+acquire can interleave with ours. Hosts where
        // acquire is a no-op when already held (in-process CuLockManager)
        // give no signal that we lost — verify we're now the holder before
        // proceeding. The CLI's O_EXCL file lock would surface this as a throw from
        // acquire instead; this re-check is a belt-and-suspenders for that
        // path too.
        const recheck = await ctx.checkCuLock();
        if (recheck.holder !== undefined && !recheck.isSelf) {
          const text =
            ctx.formatLockHeldMessage?.(recheck.holder) ??
            DEFAULT_LOCK_HELD_MESSAGE;
          return {
            content: [{ type: "text", text }],
            isError: true,
            telemetry: { error_kind: "cu_lock_held" },
          };
        }
        // Fresh holder → any prior session's mouseButtonHeld is stale.
        // Mirrors what Gate-3 does on the acquire branch. After the
        // re-check so we only clear module state when we actually won.
        resetMouseButtonHeld();
      }
    }

    // ─── Build overrides fresh ───────────────────────────────────────────

    // Per-call AbortController for dialog dismissal. Aborted in `finally` —
    // if handleToolCall finishes (MCP timeout, throw) before the user
    // answers, the host's dialog handler sees the abort and tears down.
    const dialogAbort = new AbortController();

    // Platform discriminator (B1): mac variant carries allowedApps +
    // userDeniedAppIdentifiers; win variant has neither. The executor's
    // capabilities.platform is the source of truth — mac/win/etc — and
    // we trust it (the host built the executor for this exact platform).
    const isMacAdapter = adapter.executor.capabilities.platform === "darwin";
    const baseOverrides = {
      grantFlags: ctx.getGrantFlags(),
      coordinateMode,
      selectedDisplayId: ctx.getSelectedDisplayId(),
      displayPinnedByModel: ctx.getDisplayPinnedByModel?.(),
      displayResolvedForApps: ctx.getDisplayResolvedForApps?.(),
      onPermissionRequest: wrapPermission
        ? (req: CuPermissionRequest) => wrapPermission(req, dialogAbort.signal)
        : undefined,
      onTeachPermissionRequest: wrapTeachPermission
        ? (req: CuTeachPermissionRequest) =>
            wrapTeachPermission(req, dialogAbort.signal)
        : undefined,
      onAppsHidden: ctx.onAppsHidden,
      getClipboardStash: ctx.getClipboardStash,
      onClipboardStashChanged: ctx.onClipboardStashChanged,
      onResolvedDisplayUpdated: ctx.onResolvedDisplayUpdated,
      onDisplayPinned: ctx.onDisplayPinned,
      onDisplayResolvedForApps: ctx.onDisplayResolvedForApps,
      onTeachModeActivated: ctx.onTeachModeActivated,
      onTeachStep: ctx.onTeachStep,
      onTeachWorking: ctx.onTeachWorking,
      getTeachModeActive: ctx.getTeachModeActive,
      // Undefined → handleToolCall's sync Gate-3 no-ops. The async gate
      // above already ran.
      checkCuLock: undefined,
      acquireCuLock: undefined,
      isAborted: ctx.isAborted,
      vlQuery: ctx.vlQuery,
      // SoM enrichment hooks — global marks (always stored, used by
      // handleMoveMouse for mark_id) + loop-local marks (used by
      // buildLocateInjection for the loop's zoom hint text).
      getActiveLocate: () => activeLocate,
      onLocateMarksUpdated: (marks: import("./clickTarget.js").Mark[]) => {
        lastZoomMarks = marks;
        if (activeLocate) {
          activeLocate = { ...activeLocate, marks };
        }
      },
      getLastZoomMarks: () => lastZoomMarks,
    };
    const overrides: ComputerUseOverrides = isMacAdapter
      ? {
          platform: "darwin",
          allowedApps: [...ctx.getAllowedApps()],
          userDeniedAppIdentifiers: ctx.getUserDeniedAppIdentifiers(),
          ...baseOverrides,
        }
      : { platform: "win32", ...baseOverrides };

    logger.debug(
      `[${serverName}] tool=${name} allowedApps=${allowedAppsOf(overrides).length} coordMode=${coordinateMode}`,
    );

    // ─── Dispatch ────────────────────────────────────────────────────────
    try {
      const result = await handleToolCall(adapter, name, args, overrides);

      // ─── Locate loop state management ────────────────────────────────
      const { buildLocateInjection } = await import("./clickTarget.js");

      if (name === "vision_locate" && (result as any).locateLoop) {
        activeLocate = (result as any).locateLoop;
        delete (result as any).locateLoop;
        const injection = buildLocateInjection(activeLocate!, name);
        result.content.push({ type: "text", text: injection });
        logger.debug(`[${serverName}] locate loop ENTER target="${activeLocate!.target}"`);
        logger.debug(`[${serverName}] locate injection:\n${injection}`);
      } else if (name === "accept") {
        if (!activeLocate) {
          result.content.push({ type: "text", text: "No active vision_locate loop. Call vision_locate first to enter visual positioning mode." });
          result.isError = true;
        } else if (result.isError) {
          // accept error — stay in loop, inject guidance
          const injection = buildLocateInjection(activeLocate, name);
          result.content.push({ type: "text", text: injection });
        } else {
          const target = activeLocate.target;
          logger.debug(`[${serverName}] locate loop EXIT: accepted "${target}"`);
          result.content.push({ type: "text", text: `[Vision Locate] Current cursor position snapshotted for "${target}".` });
          activeLocate = null;
        }
      } else if (activeLocate) {
        // Inside locate loop — track moved state and inject guidance.
        if (name === "mouse_move" && !result.isError) {
          activeLocate = { ...activeLocate, moved: true };
        }
        const injection = buildLocateInjection(activeLocate, name);
        result.content.push({ type: "text", text: injection });
        logger.debug(`[${serverName}] locate loop ${name}: injection appended, moved=${activeLocate.moved}`);
      } else if (["left_click", "double_click", "triple_click", "right_click", "middle_click"].includes(name) && !result.isError) {
        const tip = "Tip: For reliable clicking, prefer `screenshot`, `zoom`, or `screenshot_window`, read the text SoM list, then use `mouse_move(mark_id: N)` instead of guessing coordinates." +
          (canSuggestVisionLocate() ? " For complex visual targets that SoM can't detect, use `vision_locate`." : "");
        result.content.push({ type: "text", text: tip });
      } else if (name === "screenshot" && !result.isError) {
        const tip = "Tip: If your next step is to click a UI element, read the text SoM list above and use `mouse_move(mark_id: N)` to jump directly to a detected element." +
          (canSuggestVisionLocate() ? " For unlabeled or custom-drawn targets that SoM missed, use `vision_locate`." : "");
        result.content.push({ type: "text", text: tip });
      }

      return result;
    } finally {
      dialogAbort.abort();
    }
  };
}

export function createComputerUseMcpServer(
  adapter: ComputerUseHostAdapter,
  coordinateMode: CoordinateMode,
  context?: ComputerUseSessionContext,
): Server {
  const { serverName, logger } = adapter;

  const server = new Server(
    { name: serverName, version: "0.1.3" },
    { capabilities: { tools: {}, logging: {} } },
  );

  const tools = buildComputerUseTools(
    adapter.executor.capabilities,
    coordinateMode,
  );

  server.setRequestHandler(ListToolsRequestSchema, async () =>
    adapter.isDisabled() ? { tools: [] } : { tools },
  );

  if (context) {
    const dispatch = bindSessionContext(adapter, coordinateMode, context);
    server.setRequestHandler(
      CallToolRequestSchema,
      async (request): Promise<CallToolResult> => {
        const { screenshot: _s, telemetry: _t, ...result } = await dispatch(
          request.params.name,
          request.params.arguments ?? {},
        );
        return result;
      },
    );
    return server;
  }

  // Legacy: no context → stub handler. Reached only if something calls the
  // server over MCP transport WITHOUT going through a binder (a wiring
  // regression). Clear error instead of silent failure.
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      logger.warn(
        `[${serverName}] tool call "${request.params.name}" reached the stub handler — no session context bound. Per-session state unavailable.`,
      );
      return {
        content: [
          {
            type: "text",
            text: "This computer-use server instance is not wired to a session. Per-session app permissions are not available on this code path.",
          },
        ],
        isError: true,
      };
    },
  );

  return server;
}
