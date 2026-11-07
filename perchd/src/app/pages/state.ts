/**
 * The pages' own small settings that no other store holds: the new tab page's layout, dismissed
 * suggestions, onboarding, the default permission mode and the site rules. One record, sealed with
 * the profile's data key (vault.ts), written whole on every change.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NtpLayout, Onboarding, PermissionMode, SiteRule } from "../../../../ui-pages/src/api";
import { ensurePrivateDir, KeyedQueue, writePrivate } from "../files";
import type { Vault } from "../vault";

export type PagesSettings = {
  readonly layout: NtpLayout;
  readonly dismissed: readonly string[];
  readonly onboarding: Onboarding;
  readonly mode: PermissionMode;
  readonly siteRules: readonly SiteRule[];
  /** Set after an import brought something in, so the import suggestion goes away. */
  readonly imported: boolean;
};

export const DEFAULT_PAGES_SETTINGS: PagesSettings = {
  layout: { railOpen: true, hidden: [], recentTab: "chats" },
  dismissed: [],
  onboarding: { finished: false, done: [] },
  mode: "guard",
  siteRules: [],
  imported: false,
};

const RECORD = "pages-settings";
const FILE = `${RECORD}.enc`;

export class PagesState {
  private value: PagesSettings | null = null;
  private readonly queue = new KeyedQueue();

  constructor(private readonly dir: string, private readonly vault: Vault) {}

  async get(): Promise<PagesSettings> {
    if (this.value) return this.value;
    const blob = await readFile(join(this.dir, FILE)).catch(() => null);
    // A record that does not open (moved, edited, another key) starts over rather than locking the pages out.
    const saved = blob ? await this.vault.openJson<Partial<PagesSettings>>(RECORD, new Uint8Array(blob)).catch(() => ({})) : {};
    this.value ??= { ...DEFAULT_PAGES_SETTINGS, ...saved };
    return this.value;
  }

  update(change: (current: PagesSettings) => PagesSettings): Promise<PagesSettings> {
    return this.queue.run(RECORD, async () => {
      const next = change(await this.get());
      await ensurePrivateDir(this.dir);
      await writePrivate(this.dir, FILE, await this.vault.sealJson(RECORD, next));
      this.value = next;
      return next;
    });
  }
}
