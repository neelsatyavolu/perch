/** The app API's routes. Each handler gets checked input and returns JSON (or text for export). */

import type { ArtifactServer } from "./artifact-server";
import type { FileRegistry } from "./attachments";
import type { ArtifactStore } from "./artifacts";
import type { Windows } from "./app";
import type { ChatStore } from "./chats";
import type { PagesApi } from "./pages-api";
import type { AppInfo, ArtifactKind, Chat, ChatSettings, TabInfo } from "./protocol";
import { checkSameKind, endPrivateChats, isPrivateTab } from "./incognito";
import { AppError, type RunManager } from "./runs";
import * as v from "./validate";

export type RouteContext = {
  chats: ChatStore;
  artifacts: ArtifactStore;
  runs: RunManager;
  windows: Windows;
  artifactServer: ArtifactServer;
  info: () => AppInfo;
  models: string[];
  readonly defaults: ChatSettings;
  /** Sets the model and effort every new chat starts with. */
  setDefaults: (patch: Partial<Pick<ChatSettings, "model" | "effort">>) => Promise<ChatSettings>;
  /** Perch's own pages (pages-api.ts); null when this app does not serve them. */
  pages: PagesApi | null;
  /** Files the user attached through the browser's open panel. */
  files: FileRegistry;
};

type Handler = (ctx: RouteContext, params: string[], body: unknown, query: URLSearchParams) => Promise<unknown> | unknown;
/** `browser`: only the browser reports tabs; pages read them. See `browserToken` in server.ts. */
type Route = { method: string; path: RegExp; handler: Handler; browser?: boolean };

const ID = "([\\w.:-]{1,128})";
const route = (method: string, path: string, handler: Handler): Route => ({ method, path: new RegExp(`^${path.replaceAll(":id", ID)}$`), handler });
const browserRoute = (method: string, path: string, handler: Handler): Route => ({ ...route(method, path, handler), browser: true });

function chatOf(ctx: RouteContext, id: string): Chat {
  const chat = ctx.chats.get(id);
  if (!chat) throw new AppError("This chat no longer exists", 404);
  return chat;
}

/** Returns the chat after telling every page it changed. */
function announced(ctx: RouteContext, chat: Chat): Chat {
  ctx.runs.announce(chat.id);
  return chat;
}

function chatView(ctx: RouteContext, chat: Chat) {
  return { chat, run: ctx.runs.snapshot(chat.id), artifacts: ctx.artifacts.forChat(chat.id).map((r) => ctx.runs.artifactMeta(r)) };
}

async function sideChat(ctx: RouteContext, tabId: string, body: unknown) {
  const o = v.object(body);
  v.onlyKeys(o, ["chatId", "windowId", "settings"]);
  const tab = { id: tabId, windowId: v.id(o.windowId, "windowId") };
  const incognito = isPrivateTab(ctx.windows, tabId);
  if (o.chatId !== undefined) {
    checkSameKind(chatOf(ctx, v.id(o.chatId, "chatId")), incognito);
    return announced(ctx, await ctx.chats.attach(String(o.chatId), tab));
  }
  const settings = o.settings === undefined ? {} : v.settingsPatch(o.settings, ctx.models);
  return announced(ctx, await ctx.chats.create({ tab, settings: { ...ctx.defaults, ...settings }, incognito }));
}

/** A page's tab with the target id the browser reported for it; a page never picks the target. */
function reported(ctx: RouteContext, tab: TabInfo): TabInfo {
  const { targetId: _, ...rest } = tab;
  const targetId = ctx.windows.tab(tab.id)?.targetId;
  return targetId ? { ...rest, targetId } : rest;
}

const MARKER = /\[\[artifact:([^\]]+)\]\]/g;

/**
 * A branch gets its own copies of the artifacts its messages show, so it keeps them when the
 * source chat is deleted, and new versions in one chat do not change the other.
 */
async function branchChat(ctx: RouteContext, sourceId: string, messageId: string): Promise<Chat> {
  const branch = await ctx.chats.branch(sourceId, messageId);
  const referenced = new Set(branch.messages.flatMap((m) => [...(m.artifacts ?? []), ...[...m.text.matchAll(MARKER)].map((x) => x[1]!)]));
  const copies = new Map<string, string>();
  for (const id of referenced) {
    if (ctx.artifacts.get(id)?.chatId === sourceId) copies.set(id, (await ctx.artifacts.copy(id, branch.id)).id);
  }
  if (!copies.size) return branch;
  const swap = (id: string) => copies.get(id) ?? id;
  return ctx.chats.update(branch.id, (c) => ({
    ...c,
    messages: c.messages.map((m) => ({
      ...m,
      text: m.text.replace(MARKER, (_, id: string) => `[[artifact:${swap(id)}]]`),
      ...(m.artifacts ? { artifacts: m.artifacts.map(swap) } : {}),
    })),
  }));
}

function artifactVersion(ctx: RouteContext, id: string, query: URLSearchParams) {
  const record = ctx.artifacts.get(id);
  if (!record) throw new AppError("This artifact no longer exists", 404);
  const version = query.has("version") ? Number(query.get("version")) : record.versions.length;
  const content = Number.isInteger(version) && version >= 1 ? ctx.artifacts.content(id, version) : undefined;
  if (!content) throw new AppError(`Version ${query.get("version")} does not exist`, 404);
  return { record, version, content };
}

const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const TEXT_EXT: Record<ArtifactKind, string> = { html: "html", markdown: "md", code: "txt", svg: "svg", csv: "csv", json: "json", image: "png" };

function fileExtension(kind: ArtifactKind, language: string | undefined, mime: string | undefined): string {
  if (kind === "image") return IMAGE_EXT[mime ?? ""] ?? "png";
  if (kind === "code" && language && /^[\w]{1,16}$/.test(language)) return language;
  return TEXT_EXT[kind];
}

export function exportMarkdown(ctx: RouteContext, chat: Chat): string {
  const titleOf = (id: string) => ctx.artifacts.get(id)?.title ?? "artifact";
  const lines = [`# ${chat.title}`, ""];
  for (const m of chat.messages) {
    lines.push(`**${m.role === "user" ? "You" : "Perch"}** · ${m.time.slice(0, 16).replace("T", " ")}`, "");
    lines.push(m.text.replace(MARKER, (_, id: string) => `[Artifact: ${titleOf(id)}]`), "");
    if (m.stopped) lines.push("_Stopped_", "");
    if (m.error) lines.push(`_${m.error}_`, "");
  }
  return lines.join("\n");
}

export const ROUTES: Route[] = [
  route("GET", "/api/info", (ctx) => ctx.info()),
  route("PATCH", "/api/defaults", (ctx, _, body) => {
    const o = v.object(body);
    v.onlyKeys(o, ["model", "effort"]);
    return ctx.setDefaults(v.settingsPatch(o, ctx.models));
  }),
  route("GET", "/api/chats", (ctx) => ctx.chats.list().map((c) => ctx.runs.summary(c))),
  route("POST", "/api/chats", async (ctx, _, body) => {
    const o = v.object(body ?? {});
    v.onlyKeys(o, ["title", "tab", "settings"]);
    const settings = o.settings === undefined ? {} : v.settingsPatch(o.settings, ctx.models);
    const chat = await ctx.chats.create({
      title: v.optionalText(o.title, "title", 200),
      tab: o.tab === undefined || o.tab === null ? null : v.tabRef(o.tab),
      settings: { ...ctx.defaults, ...settings },
    });
    return announced(ctx, chat);
  }),
  route("GET", "/api/chats/:id", (ctx, [id]) => chatView(ctx, chatOf(ctx, id!))),
  route("PATCH", "/api/chats/:id", async (ctx, [id], body) => {
    chatOf(ctx, id!);
    const o = v.object(body);
    v.onlyKeys(o, ["title", "draft", "scrollTop", "settings", "pinned", "read"]);
    const pinned = o.pinned === undefined ? undefined : v.bool(o.pinned, "pinned");
    if (o.read !== undefined && o.read !== true) throw new AppError('"read" can only be true');
    const read = o.read === true;
    const title = v.optionalText(o.title, "title", 200)?.trim();
    const draft = v.optionalText(o.draft, "draft", 50_000);
    const scrollTop = o.scrollTop === undefined ? undefined : v.nonNegativeNumber(o.scrollTop, "scrollTop");
    const settings = o.settings === undefined ? undefined : v.settingsPatch(o.settings, ctx.models);
    if (title === "") throw new AppError("A chat title cannot be empty");
    // Pinning and reading change only the list's marks, so the chat keeps its place.
    const marksOnly = title === undefined && draft === undefined && scrollTop === undefined && !settings;
    const updated = await ctx.chats.update(
      id!,
      ({ pinned: wasPinned, ...c }) => ({
        ...c,
        ...((pinned ?? wasPinned) ? { pinned: true as const } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(draft !== undefined ? { draft } : {}),
        ...(scrollTop !== undefined ? { scrollTop } : {}),
        ...(settings ? { settings: { ...c.settings, ...settings } } : {}),
        ...(read ? { readAt: new Date().toISOString() } : {}),
      }),
      { touch: !marksOnly },
    );
    // Drafts and scroll positions change often and only matter to the page that sent them.
    return title !== undefined || settings || pinned !== undefined || read ? announced(ctx, updated) : updated;
  }),
  route("DELETE", "/api/chats/:id", async (ctx, [id]) => {
    chatOf(ctx, id!);
    ctx.runs.cancel(id!);
    await ctx.runs.idleFor(id!);
    await ctx.artifacts.removeForChat(id!);
    await ctx.chats.remove(id!);
    ctx.runs.announceRemoved(id!);
    return { removed: id };
  }),
  route("POST", "/api/chats/:id/messages", (ctx, [id], body) => {
    const o = v.object(body);
    v.onlyKeys(o, ["text", "context", "files", "mentions", "when"]);
    const files = o.files === undefined ? [] : v.list(o.files, "files", 20).map((f, i) => ctx.files.resolve(v.id(f, `files[${i}]`)));
    // A mention names a tab the browser reported; a page never invents one.
    const mentions = o.mentions === undefined ? [] : v.list(o.mentions, "mentions", 10).map((t, i) => {
      const tab = ctx.windows.tab(v.id(t, `mentions[${i}]`));
      if (!tab) throw new AppError("That tab is closed. Pick it again with @");
      return tab;
    });
    // While a task runs: "queue" sends this once it ends, "steer" stops it and sends this now.
    const when = o.when === undefined ? "now" : v.oneOf(o.when, "when", ["now", "queue", "steer"] as const);
    const send = when === "queue" ? ctx.runs.enqueue.bind(ctx.runs) : when === "steer" ? ctx.runs.steer.bind(ctx.runs) : ctx.runs.send.bind(ctx.runs);
    return send(id!, v.text(o.text, "text", 50_001), o.context === undefined ? undefined : reported(ctx, v.tabInfo(o.context, "context")), { files, mentions });
  }),
  route("DELETE", "/api/chats/:id/queue/:queued", (ctx, [id, queued]) => ({ removed: ctx.runs.unqueue(chatOf(ctx, id!).id, v.id(queued, "queued")) })),
  route("POST", "/api/chats/:id/queue/:queued/steer", (ctx, [id, queued]) => ctx.runs.steerQueued(chatOf(ctx, id!).id, v.id(queued, "queued"))),
  // The browser registers the files the user picked in its open panel; the page gets ids only.
  browserRoute("POST", "/api/files", (ctx, _, body) => {
    const o = v.object(body);
    v.onlyKeys(o, ["paths"]);
    return { files: ctx.files.register(v.list(o.paths, "paths", 20).map((p, i) => v.text(p, `paths[${i}]`, 4096))) };
  }),
  // The @ menu: every tab the browser reported, without its CDP target.
  route("GET", "/api/tabs", (ctx) => ctx.windows.tabs().map(({ targetId: _, ...tab }) => tab)),
  route("POST", "/api/chats/:id/cancel", (ctx, [id]) => ctx.runs.stop(chatOf(ctx, id!).id)),
  route("POST", "/api/chats/:id/branch", (ctx, [id], body) => {
    const o = v.object(body);
    v.onlyKeys(o, ["messageId"]);
    chatOf(ctx, id!);
    return branchChat(ctx, id!, v.id(o.messageId, "messageId")).then(
      (chat) => announced(ctx, chat),
      (e: Error) => {
        throw new AppError(e.message, 404);
      },
    );
  }),
  route("GET", "/api/chats/:id/export", (ctx, [id]) => new Response(exportMarkdown(ctx, chatOf(ctx, id!)), { headers: { "content-type": "text/markdown; charset=utf-8" } })),
  route("POST", "/api/chats/:id/artifacts", async (ctx, [id], body) => {
    chatOf(ctx, id!);
    const o = v.object(body);
    v.onlyKeys(o, ["title", "kind", "language", "content", "mime"]);
    const record = await ctx.artifacts
      .save({ chatId: id!, title: v.text(o.title, "title", 200), kind: v.artifactKind(o.kind), language: v.optionalText(o.language, "language", 32), content: v.text(o.content, "content", 11_000_000), mime: v.optionalText(o.mime, "mime", 32) })
      .catch((e: Error) => {
        throw new AppError(e.message);
      });
    return ctx.runs.artifactMeta(record);
  }),
  route("GET", "/api/artifacts/:id", (ctx, [id], _, query) => {
    const { record, version, content } = artifactVersion(ctx, id!, query);
    return {
      meta: { ...ctx.runs.artifactMeta(record), version, url: ctx.artifactServer.urlFor(record.id, version) },
      content: record.kind === "image" ? null : content.content,
    };
  }),
  route("GET", "/api/artifacts/:id/file", (ctx, [id], _, query) => {
    const { record, content } = artifactVersion(ctx, id!, query);
    const image = record.kind === "image";
    const name = `${record.title.replace(/[^\w .-]/g, "_")}.${fileExtension(record.kind, record.language, content.mime)}`;
    return new Response(image ? Buffer.from(content.content, "base64") : content.content, {
      headers: {
        "content-type": image ? content.mime ?? "application/octet-stream" : "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${name}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  }),
  route("POST", "/api/approvals/:id", (ctx, [id], body) => {
    const o = v.object(body);
    v.onlyKeys(o, ["approved"]);
    if (!ctx.runs.decide(id!, v.bool(o.approved, "approved"))) throw new AppError("This approval is no longer waiting", 409);
    return { ok: true };
  }),
  route("GET", "/api/windows/:id", (ctx, [id]) => ctx.windows.state(id!)),
  route("POST", "/api/pages/([A-Za-z]{1,64})", (ctx, [method], body) => {
    if (!ctx.pages) throw new AppError("not found", 404);
    return ctx.pages.call(method!, body);
  }),
  // The browser's perch-artifact:// loader (plan 3b task 12): perch-artifact://<id>/<version>.
  browserRoute("GET", "/api/artifact-frames/:id/(\\d{1,5})", (ctx, [id, version]) => ctx.artifactServer.serve(id!, Number(version))),
  browserRoute("POST", "/api/windows/:id/active", (ctx, [id], body) => {
    const o = v.object(body);
    v.onlyKeys(o, ["tab"]);
    return ctx.windows.activate(id!, o.tab === null ? null : v.tabInfo({ ...v.object(o.tab, '"tab"'), windowId: id }));
  }),
  route("GET", "/api/tabs/:id/chat", (ctx, [id]) => {
    const chat = ctx.chats.forTab(id!);
    return chat ? chatView(ctx, chat) : { chat: null, run: null, artifacts: [] };
  }),
  route("POST", "/api/tabs/:id/chat", (ctx, [id], body) => sideChat(ctx, id!, body)),
  browserRoute("POST", "/api/tabs/:id/move", async (ctx, [id], body) => {
    const o = v.object(body);
    v.onlyKeys(o, ["windowId"]);
    return { chat: (await ctx.chats.moveTab(id!, v.id(o.windowId, "windowId"))) ?? null };
  }),
  browserRoute("PUT", "/api/tabs", async (ctx, _, body) => {
    const o = v.object(body);
    v.onlyKeys(o, ["tabs"]);
    if (!Array.isArray(o.tabs) || o.tabs.length > 10_000) throw new AppError('"tabs" must be a list of up to 10,000 tabs');
    const tabs = o.tabs.map((t, i) => v.tabInfo(t, `tabs[${i}]`));
    ctx.windows.replace(tabs);
    const released = await ctx.chats.keepTabs(new Set(tabs.map((t) => t.id)));
    for (const chatId of released) ctx.runs.announce(chatId);
    await endPrivateChats(ctx);
    return { released };
  }),
  browserRoute("PATCH", "/api/tabs/:id", (ctx, [id], body) => {
    const o = v.object(body);
    v.onlyKeys(o, ["windowId", "title", "url", "targetId", "incognito", "favicon"]);
    const tab = v.tabInfo({ ...o, id });
    return { state: ctx.windows.update(tab) };
  }),
  browserRoute("DELETE", "/api/tabs/:id", async (ctx, [id]) => {
    ctx.windows.forget(id!);
    const chat = (await ctx.chats.releaseTab(id!)) ?? null;
    await endPrivateChats(ctx);
    return { chat: chat && ctx.chats.get(chat.id) ? chat : null };
  }),
];

export function match(method: string, path: string): { handler: Handler; params: string[]; browser: boolean } | "method" | null {
  let wrongMethod = false;
  for (const r of ROUTES) {
    const m = path.match(r.path);
    if (!m) continue;
    if (r.method === method) return { handler: r.handler, params: m.slice(1), browser: r.browser === true };
    wrongMethod = true;
  }
  return wrongMethod ? "method" : null;
}
