/**
 * Page-element enumeration via CDP.
 *
 * Calls `Accessibility.getFullAXTree`, prunes ignored / decorative nodes,
 * and assigns sequential refs `e1`, `e2`, ... that the model uses to
 * address elements in subsequent `browser_click` / `browser_type` calls.
 *
 * No screen coordinates are produced here. Click/type dispatch resolves
 * the backendNodeId → CSS-box center via `DOM.getBoxModel` at action time,
 * and `Input.dispatchMouseEvent` operates in viewport coords inside Chrome.
 * The OS-side coordinate layer never sees a page element.
 */

import type { CdpClient } from "./cdpClient.js";
import type { PageRef, PageSnapshot } from "./types.js";

/** Raw shape from `Accessibility.getFullAXTree`. */
interface AXNode {
  nodeId: string;
  parentId?: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  description?: { type: string; value: string };
  value?: { type: string; value: string };
  ignored?: boolean;
  childIds?: string[];
  frameId?: string;
}

/**
 * Roles we drop unless they carry a meaningful accessible name. Mirrors
 * Playwright-MCP's snapshot prune: structural-only roles add noise and refs
 * burn through the model's token budget fast.
 */
const STRUCTURAL_NOISE_ROLES = new Set([
  "generic",
  "presentation",
  "none",
  "InlineTextBox",
  "RootWebArea",
  "WebArea",
  "paragraph",
  "LineBreak",
  "LayoutTableRow",
  "LayoutTable",
  "LayoutTableCell",
]);

function nodeAttr(value: { value?: string } | undefined): string {
  return value?.value ?? "";
}

function shouldKeep(node: AXNode): boolean {
  if (node.ignored) return false;
  const role = nodeAttr(node.role);
  if (!role) return false;
  const name = nodeAttr(node.name).trim();
  const desc = nodeAttr(node.description).trim();
  if (STRUCTURAL_NOISE_ROLES.has(role)) {
    // Keep noise nodes only if they actually carry text.
    return name.length > 0 || desc.length > 0;
  }
  return true;
}

/**
 * Walk one frame's AX tree depth-first and emit ref entries + indented
 * text lines. `refs` and `lines` are accumulated across frames so child
 * targets append to the same snapshot.
 */
function walkFrame(
  root: AXNode,
  byId: Map<string, AXNode>,
  frameId: string,
  refs: Record<string, PageRef>,
  lines: string[],
  nextRef: { n: number },
): void {
  function visit(node: AXNode, depth: number) {
    const keep = shouldKeep(node);
    if (keep) {
      const ref = `e${nextRef.n++}`;
      const role = nodeAttr(node.role);
      const name = nodeAttr(node.name).trim();
      const desc = nodeAttr(node.description).trim();
      refs[ref] = {
        ref,
        role,
        name,
        description: desc || undefined,
        frameId,
        backendNodeId: node.backendDOMNodeId ?? 0,
      };
      const indent = "  ".repeat(depth);
      const nameQuoted = name ? ` "${name.replace(/"/g, '\\"')}"` : "";
      const descSuffix = desc && desc !== name ? ` (${desc})` : "";
      lines.push(`${indent}- ${role}${nameQuoted}${descSuffix} [${ref}]`);
    }
    const nextDepth = keep ? depth + 1 : depth;
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) visit(child, nextDepth);
    }
  }
  visit(root, 0);
}

/**
 * Snapshot all attached page frames into a single PageSnapshot.
 *
 * Steps:
 *  1. `Target.getTargets` → first `type:"page"` target.
 *  2. `Page.enable` / `Accessibility.enable` if not already.
 *  3. `Page.getFrameTree` to discover top frame URL/title.
 *  4. `Accessibility.getFullAXTree` for the top frame.
 *  5. For each cross-process child frame (sessionId from auto-attach),
 *     pull its AX tree on that session and append.
 */
export async function enumeratePageElements(
  client: CdpClient,
): Promise<PageSnapshot> {
  await client.send("Page.enable");
  await client.send("Accessibility.enable");

  const frameTree = await client.send<{ frameTree: any }>(
    "Page.getFrameTree",
  );
  const topFrame = frameTree.frameTree.frame;
  const url: string = topFrame.url ?? "";
  // CDP doesn't expose page title via Page.getFrameTree directly; pull it
  // through Runtime.evaluate. Cheap (one round-trip).
  let title = "";
  try {
    const r = await client.send<{ result: { value?: string } }>(
      "Runtime.evaluate",
      { expression: "document.title", returnByValue: true },
    );
    title = r.result?.value ?? "";
  } catch {
    // Runtime not enabled or page unloaded — leave title empty.
  }

  const refs: Record<string, PageRef> = {};
  const lines: string[] = [];
  const nextRef = { n: 1 };

  const top = await client.send<{ nodes: AXNode[] }>(
    "Accessibility.getFullAXTree",
  );
  const byId = new Map<string, AXNode>();
  for (const n of top.nodes) byId.set(n.nodeId, n);
  // The root is the node with no parent.
  const root = top.nodes.find((n) => !n.parentId);
  if (root) {
    walkFrame(root, byId, topFrame.id, refs, lines, nextRef);
  }

  // Child frames in the same process are already in the same tree above.
  // Out-of-process iframes need to be enumerated via the OOPIF target's
  // session — those are wired by the supervisor (Phase 4). For Phase 2a
  // we ship the top-frame tree only.

  return {
    url,
    title,
    ariaText: lines.join("\n"),
    refs,
  };
}

/**
 * Resolve a ref to the box-model center in viewport coords. Used by
 * `browser_click` / `browser_type` to find the click target.
 */
export async function refCenter(
  client: CdpClient,
  ref: PageRef,
): Promise<{ x: number; y: number }> {
  // scrollIntoViewIfNeeded forgives off-screen refs that were snapshotted
  // before the user scrolled — Playwright-MCP does the same.
  try {
    await client.send("DOM.scrollIntoViewIfNeeded", {
      backendNodeId: ref.backendNodeId,
    });
  } catch {
    // Some nodes can't be scrolled (text leaves); proceed with whatever
    // viewport position they have.
  }
  const box = await client.send<{
    model: { content: number[] };
  }>("DOM.getBoxModel", { backendNodeId: ref.backendNodeId });
  // content quad is [x1,y1, x2,y2, x3,y3, x4,y4]. Center = mean of corners.
  const q = box.model.content;
  const cx = (q[0] + q[2] + q[4] + q[6]) / 4;
  const cy = (q[1] + q[3] + q[5] + q[7]) / 4;
  return { x: cx, y: cy };
}
