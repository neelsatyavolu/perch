/**
 * The app API in one piece: stores, runs, the artifact origin, what each window shows, and the
 * HTTP server. Perch's pages talk to this; the browser reports tabs and windows to it.
 */

import { join } from "node:path";
import { startArtifactServer, type ArtifactServer } from "./artifact-server";
import { FileRegistry } from "./attachments";
import { ArtifactStore } from "./artifacts";
import { ChatStore, DEFAULT_SETTINGS } from "./chats";
import type { PagesApi } from "./pages-api";
import type { AppEvent, AppInfo, Chat, ChatSettings, ModelInfo, TabInfo, WindowState } from "./protocol";
import { fitEffort } from "./effort";
import { RunManager, type RunDeps, type Runner } from "./runs";
import { startServer, type Listen, type Server } from "./server";
import type { Vault } from "./vault";

export type AppOptions = {
  dataDir: string;
  vault: Vault;
  runner: Runner;
  /** The chat models; a function when the list changes while Perch runs (a sign-in, a catalog refresh). */
  models: ModelInfo[] | (() => ModelInfo[]);
  defaults?: Partial<ChatSettings>;
  /** Origins of Perch's pages, such as chrome://perch-chat. */
  allowedOrigins: string[];
  listen?: Listen;
  /** A folder of built pages served at /ui/, for development without the browser. */
  uiDir?: string;
  /** The API token; Perch's browser picks it and hands it to its pages. Random when left out. */
  token?: string;
  /** The browser's own token for reporting tabs, inside Perch (server.ts). */
  browserToken?: string;
  /** Perch's own pages (ui-pages) through `POST /api/pages/<method>`; left out, those routes are not found. */
  pages?: (core: PagesCore) => PagesApi;
  /** Every chat status change (RunDeps.onStatus): the browser's perch dot. */
  onStatus?: RunDeps["onStatus"];
  /** Names a chat after its first reply (RunDeps.nameChat). */
  nameChat?: RunDeps["nameChat"];
  /** False keeps scheduled messages from being sent (tests). */
  scheduler?: boolean;
  /** The user's tab text for a message (RunDeps.pageText). */
  pageText?: RunDeps["pageText"];
  /** Artifacts on `perch-artifact://`, when the browser that runs perchd serves that scheme. */
  artifactScheme?: boolean;
  /** The chat whose agent opened the tab with this target id, if one did. */
  agentChatFor?: (targetId: string) => string | undefined;
};

/** What the pages API gets from the app: its chats, runs, an event to the pages, and the new-chat defaults. */
export type PagesCore = {
  chats: ChatStore;
  runs: RunManager;
  emit: (event: string, data: unknown) => void;
  setDefaults: (patch: Partial<ChatSettings>) => void;
  /** The chat models and the settings a new chat starts with. */
  info: () => AppInfo;
  /** Files the person picked in the browser's open panel, by the id the page holds. */
  files: FileRegistry;
};

export type App = {
  chats: ChatStore;
  artifacts: ArtifactStore;
  runs: RunManager;
  artifactServer: ArtifactServer;
  server: Server;
  token: string;
  info(): AppInfo;
  windows: Windows;
  pages: PagesApi | null;
  stop(): Promise<void>;
};

/**
 * What each window's sidebar shows: the active tab and that tab's side chat. Every change to a
 * window's active tab, or to that tab's title or address, reaches the pages as `window.active`.
 */
export class Windows {
  private active = new Map<string, TabInfo | null>();
  private known = new Map<string, TabInfo>();

  constructor(
    private readonly chats: ChatStore,
    private readonly emit: (event: AppEvent) => void = () => {},
    /** The chat whose agent opened the tab with this target id, if one did. */
    private readonly agentChatFor: (targetId: string) => string | undefined = () => undefined,
  ) {}

  /**
   * The chat a tab's sidebar shows: its own side chat, or for an agent's tab the user brought into
   * view, the chat whose agent works in it (as in Aside).
   */
  chatFor(tabId: string): Chat | undefined {
    const own = this.chats.forTab(tabId);
    if (own) return own;
    const targetId = this.known.get(tabId)?.targetId;
    const agentChat = targetId ? this.agentChatFor(targetId) : undefined;
    return agentChat ? this.chats.get(agentChat) : undefined;
  }

  state(windowId: string): WindowState {
    const tab = this.active.get(windowId) ?? null;
    return { windowId, tab, chatId: tab ? this.chatFor(tab.id)?.id ?? null : null };
  }

  /** The browser switched tabs in a window. A tab that arrives from another window brings its side chat. */
  async activate(windowId: string, tab: TabInfo | null): Promise<WindowState> {
    if (tab) {
      this.known.set(tab.id, tab);
      const chat = this.chats.forTab(tab.id);
      if (chat && chat.tab?.windowId !== windowId) await this.chats.moveTab(tab.id, windowId);
    }
    this.active.set(windowId, tab);
    return this.announce(windowId);
  }

  /** A tab's title or address changed. The window showing it hears about it. */
  update(tab: TabInfo): WindowState | null {
    this.known.set(tab.id, tab);
    if (this.active.get(tab.windowId)?.id !== tab.id) return null;
    this.active.set(tab.windowId, tab);
    return this.announce(tab.windowId);
  }

  /** Every tab the browser has open now, in every window. A window whose active tab is gone shows none. */
  replace(tabs: TabInfo[]): void {
    const ids = new Set(tabs.map((t) => t.id));
    this.known = new Map(tabs.map((t) => [t.id, t]));
    for (const [w, t] of this.active) {
      if (t && !ids.has(t.id)) {
        this.active.set(w, null);
        this.announce(w);
      }
    }
  }

  forget(tabId: string): void {
    this.known.delete(tabId);
    for (const [w, t] of this.active) {
      if (t?.id !== tabId) continue;
      this.active.set(w, null);
      this.announce(w);
    }
  }

  tab(tabId: string): TabInfo | undefined {
    return this.known.get(tabId);
  }

  tabs(): TabInfo[] {
    return [...this.known.values()];
  }

  private announce(windowId: string): WindowState {
    const state = this.state(windowId);
    this.emit({ type: "window.active", state });
    return state;
  }
}

/**
 * Whose artifacts never touch the disk: private chats, and any chat id the store does not know
 * (a private chat already closed, say), so a mistake keeps a file off the disk rather than on it.
 */
export function keptInMemory(chats: Pick<ChatStore, "get">): (chatId: string) => boolean {
  return (chatId) => {
    const chat = chats.get(chatId);
    return !chat || chat.incognito === true;
  };
}

export async function startApp(opts: AppOptions): Promise<App> {
  const chats = await ChatStore.load(join(opts.dataDir, "chats"), opts.vault);
  const artifacts = await ArtifactStore.load(join(opts.dataDir, "artifacts"), opts.vault, keptInMemory(chats));
  let publish: (event: AppEvent) => void = () => {};
  const windows = new Windows(chats, (event) => publish(event), opts.agentChatFor);
  let ownOrigin: string | null = null;
  // Perch's pages may frame artifacts; so may the development pages this server itself serves.
  const artifactServer = startArtifactServer({ store: artifacts, frameAncestors: () => [...opts.allowedOrigins, ...(opts.uiDir && ownOrigin ? [ownOrigin] : [])], browserScheme: opts.artifactScheme === true });
  const runs = new RunManager({
    chats,
    artifacts,
    // A chat keeps its effort when it changes model; each run gets the nearest one the model takes.
    runner: (input) => opts.runner({ ...input, settings: { ...input.settings, effort: fitEffort(models().find((m) => m.id === input.settings.model)?.efforts, input.settings.effort) } }),
    emit: (event) => publish(event),
    artifactUrl: artifactServer.urlFor,
    tabs: () => windows.tabs(),
    ...(opts.onStatus ? { onStatus: opts.onStatus } : {}),
    ...(opts.nameChat ? { nameChat: opts.nameChat } : {}),
    ...(opts.pageText ? { pageText: opts.pageText } : {}),
  });
  // Scheduled messages (scheduled.ts) are only sent by the app the browser runs, not by test apps.
  if (opts.scheduler !== false) runs.scheduler.start();
  const models = typeof opts.models === "function" ? opts.models : () => opts.models as ModelInfo[];
  let defaults: ChatSettings = { ...DEFAULT_SETTINGS, model: models()[0]?.id ?? "", ...opts.defaults };
  const info = (): AppInfo => ({ models: models(), defaults, artifactOrigin: artifactServer.origin });
  const applyDefaults = (patch: Partial<ChatSettings>) => {
    defaults = { ...defaults, ...patch };
    publish({ type: "defaults", defaults });
  };
  const files = new FileRegistry();
  const pages = opts.pages?.({
    chats,
    runs,
    emit: (event, data) => publish({ type: "pages.event", event, data }),
    setDefaults: applyDefaults,
    info: () => info(),
    files,
  }) ?? null;
  const token = opts.token ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const server = startServer({
    token,
    ...(opts.browserToken ? { browserToken: opts.browserToken } : {}),
    allowedOrigins: opts.allowedOrigins,
    listen: opts.listen ?? { port: 0 },
    uiDir: opts.uiDir,
    ctx: {
      chats, artifacts, runs, windows, info, artifactServer, pages, files,
      get models() {
        return models().map((m) => m.id);
      },
      get defaults() {
        return defaults;
      },
      // The pages keep the pick with the new tab page's, so it outlasts a restart.
      setDefaults: async (patch) => {
        if (pages) await pages.call("setComposer", [patch]);
        else applyDefaults(patch);
        return defaults;
      },
    },
  });
  publish = server.publish;
  ownOrigin = server.origin;
  return {
    chats,
    artifacts,
    runs,
    artifactServer,
    server,
    token,
    info,
    windows,
    pages,
    async stop() {
      runs.scheduler.stop();
      for (const chat of chats.list()) runs.cancel(chat.id);
      await runs.idle();
      server.stop();
      artifactServer.stop();
    },
  };
}
