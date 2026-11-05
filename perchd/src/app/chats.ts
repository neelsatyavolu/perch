/**
 * Chats on disk, one encrypted file per chat (spec 11.1: encrypted per record). The store keeps
 * the decrypted chats in memory, hands out new objects on every change, and writes each chat's
 * changes in order.
 *
 * Side chats (spec 5.3): a chat with `tab` set belongs to that tab. One tab has at most one side
 * chat; opening another one moves the old chat to history.
 */

import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDir, KeyedQueue, UUID, writePrivate } from "./files";
import type { Chat, ChatSettings, TabRef } from "./protocol";
import type { Vault } from "./vault";

export const DEFAULT_SETTINGS: ChatSettings = Object.freeze({ mode: "guard", model: "", effort: "medium", scope: "current" });
const EXT = ".chat";

export type NewChat = { title?: string; tab?: TabRef | null; settings?: Partial<ChatSettings> };

export class ChatStore {
  private chats = new Map<string, Chat>();
  private queue = new KeyedQueue();
  /** Records that could not be opened at load, by file name. They are left on disk untouched. */
  readonly problems: string[] = [];

  private constructor(private readonly dir: string, private readonly vault: Vault) {}

  static async load(dir: string, vault: Vault): Promise<ChatStore> {
    const store = new ChatStore(dir, vault);
    await ensurePrivateDir(dir);
    for (const name of await readdir(dir)) {
      if (!name.endsWith(EXT)) continue;
      const id = name.slice(0, -EXT.length);
      try {
        const chat = await vault.openJson<Chat>(id, new Uint8Array(await readFile(join(dir, name))));
        if (chat.id !== id) throw new Error("id mismatch");
        store.chats.set(id, chat);
      } catch {
        store.problems.push(name);
      }
    }
    return store;
  }

  /** Newest first. */
  list(): Chat[] {
    return [...this.chats.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Chat | undefined {
    return this.chats.get(id);
  }

  async create(init: NewChat): Promise<Chat> {
    const now = new Date().toISOString();
    const chat: Chat = {
      id: crypto.randomUUID(),
      title: init.title?.trim() || "New chat",
      createdAt: now,
      updatedAt: now,
      settings: { ...DEFAULT_SETTINGS, ...init.settings },
      messages: [],
      tab: null,
      draft: "",
      scrollTop: 0,
    };
    await this.save(chat);
    return init.tab ? this.attach(chat.id, init.tab) : chat;
  }

  /** Applies a change to the newest version of a chat. The change must return a new object. */
  update(id: string, change: (chat: Chat) => Chat): Promise<Chat> {
    return this.queue.run(id, async () => {
      const current = this.chats.get(id);
      if (!current) throw new Error(`no chat ${id}`);
      const next: Chat = { ...change(current), id, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
      await this.save(next);
      return next;
    });
  }

  async remove(id: string): Promise<void> {
    await this.queue.run(id, async () => {
      this.chats.delete(id);
      await rm(join(this.dir, `${id}${EXT}`), { force: true });
    });
  }

  /** A new chat with the messages up to and including messageId. */
  async branch(id: string, messageId: string): Promise<Chat> {
    const source = this.chats.get(id);
    if (!source) throw new Error(`no chat ${id}`);
    const at = source.messages.findIndex((m) => m.id === messageId);
    if (at < 0) throw new Error(`no message ${messageId} in this chat`);
    const created = await this.create({ title: source.title, settings: source.settings });
    return this.update(created.id, (c) => ({ ...c, messages: source.messages.slice(0, at + 1), branchOf: { chatId: id, messageId } }));
  }

  forTab(tabId: string): Chat | undefined {
    return [...this.chats.values()].find((c) => c.tab?.id === tabId);
  }

  /** Makes a chat the side chat of a tab; the tab's earlier side chat goes to history. */
  async attach(chatId: string, tab: TabRef): Promise<Chat> {
    const previous = this.forTab(tab.id);
    if (previous && previous.id !== chatId) await this.update(previous.id, (c) => ({ ...c, tab: null }));
    return this.update(chatId, (c) => ({ ...c, tab: { id: tab.id, windowId: tab.windowId } }));
  }

  /** A tab moved to another window: its side chat goes with it. */
  async moveTab(tabId: string, windowId: string): Promise<Chat | undefined> {
    const chat = this.forTab(tabId);
    return chat ? this.update(chat.id, (c) => ({ ...c, tab: { id: tabId, windowId } })) : undefined;
  }

  /** The tab closed: its side chat stays in history. */
  async releaseTab(tabId: string): Promise<Chat | undefined> {
    const chat = this.forTab(tabId);
    return chat ? this.update(chat.id, (c) => ({ ...c, tab: null })) : undefined;
  }

  /** The browser's open tabs: side chats bound to any other tab go to history. Returns their ids. */
  async keepTabs(openTabIds: ReadonlySet<string>): Promise<string[]> {
    const stale = [...this.chats.values()].filter((c) => c.tab && !openTabIds.has(c.tab.id));
    await Promise.all(stale.map((c) => this.update(c.id, (x) => ({ ...x, tab: null }))));
    return stale.map((c) => c.id);
  }

  private async save(chat: Chat): Promise<void> {
    if (!UUID.test(chat.id)) throw new Error("chat ids are UUIDs");
    await writePrivate(this.dir, `${chat.id}${EXT}`, await this.vault.sealJson(chat.id, chat));
    this.chats.set(chat.id, chat);
  }
}
