/**
 * Session-scoped consent map for takeover decisions.
 *
 * Phase 2a (isolated profile): no real consent gate — spawning a fresh
 * `~/.axiomate/browser-bridge/profile` browser touches none of the user's
 * data, so we don't prompt. This module exists so Phase 2b's takeover flow
 * (close the user's real browser, relaunch with CDP on their profile) has
 * a stable surface to plug into without restructuring.
 *
 * Keys are browser kinds (`chrome`, `edge`, ...). Replies are session-local
 * — wiped when the agent process exits. Mirrors hermes' `_session_auto_approve`
 * but simpler: no per-URL granularity, no time-based expiry.
 */

import type { BrowserKind } from "./types.js";

export type ConsentReply = "approve_once" | "approve_session" | "deny";

const sessionApprovals = new Map<BrowserKind, ConsentReply>();

export function getSessionConsent(kind: BrowserKind): ConsentReply | undefined {
  return sessionApprovals.get(kind);
}

export function setSessionConsent(
  kind: BrowserKind,
  reply: ConsentReply,
): void {
  if (reply === "approve_session" || reply === "deny") {
    sessionApprovals.set(kind, reply);
  }
  // `approve_once` is intentionally not persisted — caller acts on this
  // response, next call asks again.
}

export function clearSessionConsent(): void {
  sessionApprovals.clear();
}
