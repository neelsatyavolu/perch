/** The app API's routes. Each handler gets checked input and returns JSON (or text for export). */

import type { ArtifactServer } from "./artifact-server";
import type { ArtifactStore } from "./artifacts";
import type { Windows } from "./app";
import type { ChatStore } from "./chats";
import type { AppInfo, Chat, ChatSettings } from "./protocol";
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
  defaults: ChatSettings;
};

type Handler = (ctx: RouteContext, params: string[], body: unknown, query: URLSearchParams) => Promise<unknown> | unknown;
type Route = { method: string; path: RegExp; handler: Handler };

const ID = "([\\w.:-]{1,128})";
const route = (method: string, path: string, handler: Handler): Route => ({ method, path: new RegExp(`^${path.replaceAll(":id", ID)}$`), handler });

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
  if (o.chatId !== undefined) {
    chatOf(ctx, v.id(o.chatId, "chatId"));
    return announced(ctx, await ctx.chats.attach(String(o.chatId), tab));
  }
  const settings = o.settings === undefined ? {} : v.settingsPatch(o.settings, ctx.models);
  return announced(ctx, await ctx.chats.create({ tab, settings: { ...ctx.defaults, ...settings } }));
}

export function exportMarkdown(ctx: RouteContext, chat: Chat): string {
  const titleOf = (id: string) => ctx.artifacts.get(id)?.title ?? "artifact";
  const lines = [`# ${chat.title}`, ""];
  for (const m of chat.messages) {
    lines.push(`**${m.role === "user" ? "You" : "Perch"}** · ${m.time.slice(0, 16).replace("T", " ")}`, "");
    lines.push(m.text.replace(/\[\[artifact:([^\]]+)\]\]/g, (_, id: string) => `[Artifact: ${titleOf(id)}]`), "");
    if (m.stopped) lines.push("_Stopped_", "");
    if (m.error) lines.push(`_${m.error}_`, "");
  }
  return lines.join("\n");
}

export const ROUTES: Route[] = [
  route("GET", "/api/info", (ctx) => ctx.info()),
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
    v.onlyKeys(o, ["title", "draft", "scrollTop", "settings"]);
    const title = v.optionalText(o.title, "title", 200)?.trim();
    const draft = v.optionalText(o.draft, "draft", 50_000);
    const scrollTop = o.scrollTop === undefined ? undefined : v.nonNegativeNumber(o.scrollTop, "scrollTop");
    const settings = o.settings === undefined ? undefined : v.settingsPatch(o.settings, ctx.models);
    if (title === "") throw new AppError("A chat title cannot be empty");
    const chat = await ctx.chats.update(id!, (c) => ({
      ...c,
      ...(title !== undefined ? { title } : {}),
      ...(draft !== undefined ? { draft } : {}),
      ...(scrollTop !== undefined ? { scrollTop } : {}),
      ...(settings ? { settings: { ...c.settings, ...settings } } : {}),
    }));
    // Drafts and scroll positions change often and only matter to the page that sent them.
    return title !== undefined || settings ? announced(ctx, chat) : chat;
  }),
  route("DELETE", "/api/chats/:id", async (ctx, [id]) => {
    chatOf(ctx, id!);
    ctx.runs.cancel(id!);
    await ctx.runs.idle();
    await ctx.artifacts.removeForChat(id!);
    await ctx.chats.remove(id!);
    ctx.runs.announceRemoved(id!);
    return { removed: id };
  }),
  route("POST", "/api/chats/:id/messages", (ctx, [id], body) => {
    const o = v.object(body);
    v.onlyKeys(o, ["text", "context"]);
    return ctx.runs.send(id!, v.text(o.text, "text", 50_001), o.context === undefined ? undefined : v.tabInfo(o.context, "context"));
  }),
  route("POST", "/api/chats/:id/cancel", (ctx, [id]) => ({ stopped: ctx.runs.cancel(chatOf(ctx, id!).id) })),
  route("POST", "/api/chats/:id/branch", (ctx, [id], body) => {
    const o = v.object(body);
    v.onlyKeys(o, ["messageId"]);
    chatOf(ctx, id!);
    return ctx.chats.branch(id!, v.id(o.messageId, "messageId")).then(
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
    const record = ctx.artifacts.get(id!);
    if (!record) throw new AppError("This artifact no longer exists", 404);
    const version = query.has("version") ? Number(query.get("version")) : record.versions.length;
    const content = Number.isInteger(version) ? ctx.artifacts.content(id!, version) : undefined;
    if (!content || version < 1) throw new AppError(`Version ${query.get("version")} does not exist`, 404);
    return {
      meta: { ...ctx.runs.artifactMeta(record), version, url: ctx.artifactServer.urlFor(record.id, version) },
      content: record.kind === "image" ? null : content.content,
    };
  }),
  route("POST", "/api/approvals/:id", (ctx, [id], body) => {
    const o = v.object(body);
    v.onlyKeys(o, ["approved"]);
    if (!ctx.runs.decide(id!, v.bool(o.approved, "approved"))) throw new AppError("This approval is no longer waiting", 409);
    return { ok: true };
  }),
  route("GET", "/api/windows/:id", (ctx, [id]) => ctx.windows.state(id!)),
  route("POST", "/api/windows/:id/active", (ctx, [id], body) => {
    const o = v.object(body);
    v.onlyKeys(o, ["tab"]);
    return ctx.windows.activate(id!, o.tab === null ? null : v.tabInfo({ ...v.object(o.tab, '"tab"'), windowId: id }));
  }),
  route("GET", "/api/tabs/:id/chat", (ctx, [id]) => {
    const chat = ctx.chats.forTab(id!);
    return chat ? chatView(ctx, chat) : { chat: null, run: null, artifacts: [] };
  }),
  route("POST", "/api/tabs/:id/chat", (ctx, [id], body) => sideChat(ctx, id!, body)),
  route("POST", "/api/tabs/:id/move", async (ctx, [id], body) => {
    const o = v.object(body);
    v.onlyKeys(o, ["windowId"]);
    return { chat: (await ctx.chats.moveTab(id!, v.id(o.windowId, "windowId"))) ?? null };
  }),
  route("DELETE", "/api/tabs/:id", async (ctx, [id]) => {
    ctx.windows.forget(id!);
    return { chat: (await ctx.chats.releaseTab(id!)) ?? null };
  }),
];

export function match(method: string, path: string): { handler: Handler; params: string[] } | "method" | null {
  let wrongMethod = false;
  for (const r of ROUTES) {
    const m = path.match(r.path);
    if (!m) continue;
    if (r.method === method) return { handler: r.handler, params: m.slice(1) };
    wrongMethod = true;
  }
  return wrongMethod ? "method" : null;
}
