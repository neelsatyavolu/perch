/**
 * Finds elements anywhere on the page by role and accessible name, through Chromium's own
 * accessibility index, and gives them refs. A snapshot lists only what is near the viewport; a
 * table of 30 students or a dialog that just opened is reached here in one call, the way a
 * person would say "the Score box for Liz on Thursday".
 */

import type { Tab } from "../browser/tab";
import { refsFor } from "./refs";

export type Found = { ref: string; role: string; name: string };

type AXNode = { ignored?: boolean; role?: { value?: string }; name?: { value?: string }; backendDOMNodeId?: number };

const MAX_FOUND = 100;

/**
 * Elements whose role is `role` (any role when empty) and whose name is `name`: exactly, or as a
 * case-insensitive substring when `contains` is set. Only the main frame is searched.
 */
export async function find(tab: Tab, opts: { role?: string; name?: string; contains?: boolean }): Promise<Found[]> {
  const role = opts.role?.trim() || undefined;
  const name = opts.name?.trim() ?? "";
  const { root } = await tab.send<{ root: { backendNodeId: number } }>("DOM.getDocument", { depth: 0 });
  const { frameTree } = await tab.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
  const query = { backendNodeId: root.backendNodeId, ...(role ? { role } : {}), ...(name && !opts.contains ? { accessibleName: name } : {}) };
  const { nodes } = await tab.send<{ nodes: AXNode[] }>("Accessibility.queryAXTree", query);
  const want = name.toLowerCase();
  const refs = refsFor(tab);
  const found: Found[] = [];
  for (const node of nodes) {
    if (node.ignored || node.backendDOMNodeId === undefined) continue;
    const own = String(node.name?.value ?? "");
    if (opts.contains && want && !own.toLowerCase().includes(want)) continue;
    found.push({ ref: refs.refFor(node.backendDOMNodeId, frameTree.frame.id), role: String(node.role?.value ?? ""), name: own });
    if (found.length >= MAX_FOUND) break;
  }
  return found;
}

/** One line per element, in the snapshot's own form, so refs read the same way. */
export function foundText(found: readonly Found[], opts: { role?: string; name?: string }): string {
  if (!found.length) return `nothing on the page is ${opts.role ? `a ${opts.role} ` : ""}named "${opts.name ?? ""}"; take a snapshot to see what is there`;
  const lines = found.map((f) => `- ${f.role} "${f.name.replace(/"/g, '\\"')}" [ref=${f.ref}]`);
  return `${found.length === MAX_FOUND ? `the first ${MAX_FOUND} matches` : `${found.length} found`}:\n${lines.join("\n")}`;
}
