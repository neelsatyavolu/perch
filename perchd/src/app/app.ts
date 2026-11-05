/**
 * The app API in one piece: stores, runs, the artifact origin, what each window shows, and the
 * HTTP server. Perch's pages talk to this; the browser reports tabs and windows to it.
 */

import { join } from "node:path";
import { startArtifactServer, type ArtifactServer } from "./artifact-server";
import { ArtifactStore } from "./artifacts";
import { ChatStore, DEFAULT_SETTINGS } from "./chats";
import type { AppEvent, AppInfo, ChatSettings, ModelInfo, TabInfo, WindowState } from "./protocol";
import { RunManager, type Runner } from "./runs";
import { startServer, type Listen, type Server } from "./server";
import type { Vault } from "./vault";

export type AppOptions = {
  dataDir: string;
  vault: Vault;
  runner: Runner;
  models: ModelInfo[];
  defaults?: Partial<ChatSettings>;
  /** Origins of Perch's pages, such as chrome://perch-chat. */
  allowedOrigins: string[];
  listen?: Listen;
  /** A folder of built pages served at /ui/, for development without the browser. */
  uiDir?: string;
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
  stop(): Promise<void>;
};

/** What each window's sidebar shows: the active tab and that tab's side chat. */
export class Windows {
  private active = new Map<string, TabInfo | null>();
  private known = new Map<string, TabInfo>();

  constructor(private readonly chats: ChatStore) {}

  state(windowId: string): WindowState {
    const tab = this.active.get(windowId) ?? null;
    return { windowId, tab, chatId: tab ? this.chats.forTab(tab.id)?.id ?? null : null };
  }

  /** The browser switched tabs in a window. A tab that arrives from another window brings its side chat. */
  async activate(windowId: string, tab: TabInfo | null): Promise<WindowState> {
    if (tab) {
      this.known.set(tab.id, tab);
      const chat = this.chats.forTab(tab.id);
      if (chat && chat.tab?.windowId !== windowId) await this.chats.moveTab(tab.id, windowId);
    }
    this.active.set(windowId, tab);
    return this.state(windowId);
  }

  forget(tabId: string): void {
    this.known.delete(tabId);
    for (const [w, t] of this.active) if (t?.id === tabId) this.active.set(w, null);
  }

  tab(tabId: string): TabInfo | undefined {
    return this.known.get(tabId);
  }

  tabs(): TabInfo[] {
    return [...this.known.values()];
  }
}

export async function startApp(opts: AppOptions): Promise<App> {
  const chats = await ChatStore.load(join(opts.dataDir, "chats"), opts.vault);
  const artifacts = await ArtifactStore.load(join(opts.dataDir, "artifacts"), opts.vault);
  const windows = new Windows(chats);
  let publish: (event: AppEvent) => void = () => {};
  let ownOrigin: string | null = null;
  // Perch's pages may frame artifacts; so may the development pages this server itself serves.
  const artifactServer = startArtifactServer({ store: artifacts, frameAncestors: () => [...opts.allowedOrigins, ...(opts.uiDir && ownOrigin ? [ownOrigin] : [])] });
  const runs = new RunManager({
    chats,
    artifacts,
    runner: opts.runner,
    emit: (event) => publish(event),
    artifactUrl: artifactServer.urlFor,
    tabs: () => windows.tabs(),
  });
  const defaults: ChatSettings = { ...DEFAULT_SETTINGS, model: opts.models[0]?.id ?? "", ...opts.defaults };
  const info = (): AppInfo => ({ models: opts.models, defaults, artifactOrigin: artifactServer.origin });
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const server = startServer({
    token,
    allowedOrigins: opts.allowedOrigins,
    listen: opts.listen ?? { port: 0 },
    uiDir: opts.uiDir,
    ctx: { chats, artifacts, runs, windows, info, artifactServer, models: opts.models.map((m) => m.id), defaults },
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
    async stop() {
      for (const chat of chats.list()) runs.cancel(chat.id);
      await runs.idle();
      server.stop();
      artifactServer.stop();
    },
  };
}
