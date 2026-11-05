/**
 * A compact text view of a page for the model, built from the accessibility tree.
 *
 *   - heading "Inbox" [level=1]
 *   - button "Compose" [ref=e3]
 *   - textbox "To" [ref=e7] value="maya@chenstudio.co"
 *   - row "#100001 | $4.00"
 *     - link "View order 1" [ref=e12]
 *   - … 9,940 more below
 *
 * Interactive elements get refs. Only content within one screen above and two below the
 * scroll position is listed unless `full` is set. Secret fields always show "••••".
 */

import type { Tab } from "../browser/tab";
import { captureLayout, placement, type Layout } from "./layout";
import { RefTable, refsFor } from "./refs";
import { isSecretField, REDACTED, rememberedSecrets, secretKey } from "./secrets";

export type Snapshot = { text: string; refs: RefTable; omitted: number };
export const DEFAULT_BUDGET = 12_000;
const TEXT_LIMIT = 160;

const INTERACTIVE = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "menuitem",
  "menuitemcheckbox", "menuitemradio", "tab", "option", "slider", "spinbutton", "treeitem",
  "Date", "DateTime", "InputTime",
]);
/** Chromium's internal roles for date and time inputs, shown as one field each. */
const ROLE_NAMES: Record<string, string> = { Date: "date", DateTime: "datetime", InputTime: "time" };
/** Interactive roles that can contain more interactive elements (nested tree items). */
const NESTING = new Set(["treeitem"]);
const VALUED = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "Date", "DateTime", "InputTime"]);
const CONTAINERS = new Set([
  "navigation", "main", "search", "dialog", "alertdialog", "region", "form", "status", "alert",
  "complementary", "contentinfo", "banner", "table", "list", "menu", "menubar", "tablist", "toolbar", "tree", "grid", "listbox",
]);
const NAME_ONLY_CONTAINERS = new Set(["region", "form", "list", "banner", "contentinfo"]);

type AXValue = { value?: unknown };
type AXNode = {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  backendDOMNodeId?: number;
};
type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };
/**
 * One frame's accessibility tree. A cross-site iframe has its own session, its owning iframe
 * element in the page, and its own field attributes (node ids repeat across processes).
 */
type Tree = { frameId: string; nodes: Map<string, AXNode>; root: AXNode | undefined; session?: string; owner?: number; attrs?: Map<number, Record<string, string>> };

type Ctx = {
  trees: Map<string, Tree>;
  secrets: Set<string>;
  frameOwners: Map<number, string>;
  layout: Layout;
  refs: RefTable;
  full: boolean;
  omitted: number;
};

export async function snapshot(tab: Tab, opts: { budget?: number; full?: boolean } = {}): Promise<Snapshot> {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  await tab.send("DOM.getDocument", { depth: 0 });
  const { frameTree } = await tab.send<{ frameTree: FrameTree }>("Page.getFrameTree");
  const inProcess = flattenFrames(frameTree);
  const crossSite = [...tab.frameSessions.keys()].filter((id) => !inProcess.includes(id));
  const frames = [...inProcess, ...crossSite];
  const full = opts.full ?? false;
  await enableAccessibility(tab, undefined);
  const [owners, layout] = await Promise.all([frameOwners(tab, frames.slice(1)), captureLayout(tab)]);
  const trees = await loadTrees(tab, frames, layout, full, owners);
  await fillMissingAttrs(tab, trees, layout);
  const ctx: Ctx = { trees, secrets: rememberedSecrets(tab), frameOwners: owners, layout, refs: refsFor(tab), full, omitted: 0 };
  const main = trees.get(frames[0]!)!;
  const lines = main.root ? renderChildren(ctx, main, main.root, 0) : [];
  return fitBudget(lines, budget, ctx.omitted, ctx.refs);
}

function flattenFrames(tree: FrameTree): string[] {
  return [tree.frame.id, ...(tree.childFrames ?? []).flatMap(flattenFrames)];
}

const enabled = new WeakMap<Tab, Set<string>>();

async function enableAccessibility(tab: Tab, session: string | undefined): Promise<void> {
  let sessions = enabled.get(tab);
  if (!sessions) enabled.set(tab, (sessions = new Set()));
  const key = session ?? "main";
  if (sessions.has(key)) return;
  await tab.sendIn(session, "Accessibility.enable");
  sessions.add(key);
}

/** Leaf roles whose children add nothing to the snapshot. */
const LEAVES = new Set([...[...INTERACTIVE].filter((r) => !NESTING.has(r)), "StaticText", "img"]);

/**
 * Value-bearing fields the layout pass found no attributes for (for example in frames it did not
 * capture) get them from DOM.describeNode, so secret detection never fails open.
 */
async function fillMissingAttrs(tab: Tab, trees: Map<string, Tree>, layout: Layout): Promise<void> {
  const work: Promise<void>[] = [];
  for (const tree of trees.values()) {
    const store = tree.session ? (tree.attrs ??= new Map()) : layout.attrs;
    for (const node of tree.nodes.values()) {
      const id = node.backendDOMNodeId;
      if (id === undefined || !VALUED.has(str(node.role)) || store.has(id)) continue;
      work.push(
        tab
          .sendIn<{ node: { attributes?: string[] } }>(tree.session, "DOM.describeNode", { backendNodeId: id })
          .then(({ node: described }) => {
            const pairs = described.attributes ?? [];
            const attrs: Record<string, string> = {};
            for (let i = 0; i + 1 < pairs.length; i += 2) attrs[pairs[i]!.toLowerCase()] = pairs[i + 1]!;
            store.set(id, attrs);
          })
          .catch(() => undefined),
      );
    }
  }
  await Promise.all(work);
}

/**
 * Fetches the accessibility tree level by level, opening only nodes near the viewport.
 * A full fetch of a 10,000-row page takes about 7 s; this takes a fraction of a second.
 */
async function loadTree(tab: Tab, frameId: string, layout: Layout, full: boolean, session?: string): Promise<Tree> {
  await enableAccessibility(tab, session);
  const { node: root } = await tab.sendIn<{ node: AXNode }>(session, "Accessibility.getRootAXNode", { frameId });
  const nodes = new Map<string, AXNode>([[root.nodeId, root]]);
  let frontier = [root];
  while (frontier.length > 0) {
    const open = frontier.filter(
      // A cross-site frame is loaded in full: its node ids are not in the page's layout.
      (n) => (n.childIds?.length ?? 0) > 0 && !LEAVES.has(str(n.role)) && (full || session !== undefined || placement(layout, n.backendDOMNodeId) === "near"),
    );
    const results = await Promise.all(open.map((n) => tab.sendIn<{ nodes: AXNode[] }>(session, "Accessibility.getChildAXNodes", { id: n.nodeId, frameId })));
    frontier = [];
    for (const { nodes: batch } of results) {
      for (const node of batch) {
        if (nodes.has(node.nodeId)) continue;
        nodes.set(node.nodeId, node);
        frontier.push(node);
      }
    }
  }
  return { frameId, nodes, root, ...(session ? { session } : {}) };
}

async function loadTrees(tab: Tab, frames: string[], layout: Layout, full: boolean, owners: Map<number, string>): Promise<Map<string, Tree>> {
  const trees = new Map<string, Tree>();
  const ownerOf = new Map([...owners].map(([owner, frameId]) => [frameId, owner]));
  await Promise.all(
    frames.map(async (frameId) => {
      try {
        const session = tab.frameSessions.get(frameId);
        const tree = await loadTree(tab, frameId, layout, full, session);
        if (session) tree.owner = ownerOf.get(frameId);
        trees.set(frameId, tree);
      } catch {
        trees.set(frameId, { frameId, nodes: new Map(), root: undefined });
      }
    }),
  );
  return trees;
}

async function frameOwners(tab: Tab, childFrames: string[]): Promise<Map<number, string>> {
  const owners = new Map<number, string>();
  await Promise.all(
    childFrames.map(async (frameId) => {
      try {
        const { backendNodeId } = await tab.send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId });
        owners.set(backendNodeId, frameId);
      } catch {
        // Cross-process frames are attached separately; skip them here.
      }
    }),
  );
  return owners;
}

function str(value: AXValue | undefined): string {
  const raw = value?.value;
  return typeof raw === "string" ? raw : raw === undefined || raw === null ? "" : String(raw);
}

function clean(text: string, limit = TEXT_LIMIT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
  return cut.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function prop(node: AXNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value.value;
}

function children(tree: Tree, node: AXNode): AXNode[] {
  return (node.childIds ?? []).map((id) => tree.nodes.get(id)).filter((n): n is AXNode => n !== undefined);
}

/** Renders a node's children, collapsing runs of off-screen ones into "… N more above/below". */
function renderChildren(ctx: Ctx, tree: Tree, node: AXNode, depth: number): string[] {
  const out: string[] = [];
  let run: { where: "above" | "below"; count: number } | null = null;
  const flush = () => {
    if (run) out.push(`${"  ".repeat(depth)}- … ${run.count.toLocaleString("en-US")} more ${run.where}`);
    run = null;
  };
  for (const child of children(tree, node)) {
    const where = ctx.full ? "near" : placement(ctx.layout, child.backendDOMNodeId);
    if (where !== "near") {
      ctx.omitted += 1;
      if (run && run.where === where) run.count += 1;
      else {
        flush();
        run = { where, count: 1 };
      }
      continue;
    }
    flush();
    out.push(...renderNode(ctx, tree, child, depth));
  }
  flush();
  return out;
}

function renderNode(ctx: Ctx, tree: Tree, node: AXNode, depth: number): string[] {
  if (node.ignored) return renderChildren(ctx, tree, node, depth);
  const role = str(node.role);
  const name = clean(str(node.name));
  const pad = "  ".repeat(depth);

  // Iframe owners are page nodes; ids inside a cross-site frame may repeat them by chance.
  const ownedFrame = !tree.session && node.backendDOMNodeId !== undefined ? ctx.frameOwners.get(node.backendDOMNodeId) : undefined;
  if (ownedFrame) {
    const inner = ctx.trees.get(ownedFrame);
    const body = inner?.root ? renderChildren(ctx, inner, inner.root, depth + 1) : [];
    return [`${pad}- iframe${name ? ` "${name}"` : ""}`, ...body];
  }
  if (INTERACTIVE.has(role) && node.backendDOMNodeId !== undefined) {
    const ref = ctx.refs.refFor(node.backendDOMNodeId, tree.frameId, tree.session, tree.owner);
    const line = `${pad}- ${ROLE_NAMES[role] ?? role} "${name}" [ref=${ref}]${extras(ctx, tree, node, role)}`;
    return NESTING.has(role) ? [line, ...interactiveInside(ctx, tree, node, depth + 1)] : [line];
  }
  if (role === "heading") return [`${pad}- heading "${name}" [level=${prop(node, "level") ?? 2}]`, ...interactiveInside(ctx, tree, node, depth + 1)];
  if (role === "StaticText") return name ? [`${pad}- text "${name}"`] : [];
  if (role === "img") return name ? [`${pad}- img "${name}"`] : [];
  if (role === "row") return renderRow(ctx, tree, node, depth);
  if (CONTAINERS.has(role)) {
    const body = renderChildren(ctx, tree, node, depth + 1);
    if (body.length === 0) return [];
    if (NAME_ONLY_CONTAINERS.has(role) && !name) return renderChildren(ctx, tree, node, depth);
    return [`${pad}- ${role}${name ? ` "${name}"` : ""}`, ...body];
  }
  return renderClickable(ctx, tree, node, depth) ?? renderChildren(ctx, tree, node, depth);
}

/**
 * A plain element styled as clickable (cursor: pointer) with text and nothing interactive inside,
 * such as a custom suggestion or menu item, becomes one line with a ref.
 */
function renderClickable(ctx: Ctx, tree: Tree, node: AXNode, depth: number): string[] | null {
  const id = node.backendDOMNodeId;
  if (id === undefined || tree.session || !ctx.layout.clickable.has(id)) return null;
  const inner = renderChildren(ctx, tree, node, depth + 1);
  if (inner.length === 0 || inner.some((line) => line.includes("[ref="))) return null;
  const full = textOf(tree, node).join(" ").replace(/\s+/g, " ").trim();
  if (!full) return null;
  const ref = ctx.refs.refFor(id, tree.frameId, tree.session, tree.owner);
  const pad = "  ".repeat(depth);
  // Short items read as one line; a long clickable block keeps its text so nothing is lost.
  if (full.length <= SHORT_CLICKABLE && inner.length <= 3) return [`${pad}- clickable "${clean(full)}" [ref=${ref}]`];
  return [`${pad}- clickable [ref=${ref}]`, ...inner];
}

const SHORT_CLICKABLE = 120;

function textOf(tree: Tree, node: AXNode): string[] {
  const role = str(node.role);
  if (role === "StaticText" || role === "img") return [str(node.name)].filter(Boolean);
  return children(tree, node).flatMap((child) => textOf(tree, child));
}

/** Only the lines with refs from a node's subtree: links in headings, nested tree items. */
function interactiveInside(ctx: Ctx, tree: Tree, node: AXNode, depth: number): string[] {
  return renderChildren(ctx, tree, node, depth).filter((line) => line.includes("[ref="));
}

/** A table row on one line: plain cells as text, interactive cells as their own lines below. */
function renderRow(ctx: Ctx, tree: Tree, row: AXNode, depth: number): string[] {
  const plain: string[] = [];
  const actionable: string[] = [];
  for (const cell of children(tree, row)) {
    const inner = renderChildren(ctx, tree, cell, depth + 1);
    if (inner.some((line) => line.includes("[ref="))) actionable.push(...inner.filter((line) => line.includes("[ref=")));
    else if (str(cell.name).trim()) plain.push(clean(str(cell.name), 60));
  }
  return [`${"  ".repeat(depth)}- row "${plain.join(" | ")}"`, ...actionable];
}

function extras(ctx: Ctx, tree: Tree, node: AXNode, role: string): string {
  const parts: string[] = [];
  if (VALUED.has(role)) {
    const id = node.backendDOMNodeId;
    const attrs = id === undefined ? undefined : tree.session ? tree.attrs?.get(id) : ctx.layout.attrs.get(id);
    const value = str(node.value);
    const key = id === undefined ? "" : secretKey(id, tree.session);
    if (id !== undefined && attrs && isSecretField(attrs)) ctx.secrets.add(key);
    // Fail closed: a field with a value but no known attributes is treated as secret.
    const secret = id !== undefined && (ctx.secrets.has(key) || (value !== "" && attrs === undefined && role !== "combobox"));
    if (secret) {
      if (value) parts.push(`value="${REDACTED}"`);
    } else if (value) parts.push(`value="${clean(value, 200)}"`);
  }
  const checked = prop(node, "checked");
  if (checked !== undefined) parts.push(`checked=${checked}`);
  const expanded = prop(node, "expanded");
  if (expanded !== undefined) parts.push(`expanded=${expanded}`);
  if (prop(node, "disabled") === true) parts.push("disabled");
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function fitBudget(lines: string[], budget: number, omitted: number, refs: RefTable): Snapshot {
  const notice = (n: number) => `- … ${n.toLocaleString("en-US")} more lines cut at ${budget.toLocaleString("en-US")} characters; scroll or ask for the full page`;
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    size += lines[i]!.length + 1;
    if (size > budget - 120) {
      const dropped = lines.length - i;
      return { text: [...lines.slice(0, i), notice(dropped)].join("\n"), refs, omitted: omitted + dropped };
    }
  }
  return { text: lines.join("\n"), refs, omitted };
}
