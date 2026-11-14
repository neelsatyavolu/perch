/** A Chromium instance controlled over the private pipe. */

import type { CdpConnection } from "../cdp/connection";
import { findChromeForTesting, launchChromium } from "../cdp/pipe";
import { withoutPasskeys } from "./no-passkeys";
import { Tab } from "./tab";

export type TabInfo = { id: string; url: string; title: string };

/** Agent windows use a common laptop size, so pages lay out as they do for people. */
const AGENT_WINDOW = { width: 1440, height: 900 };

export class Browser {
  /** Pages opened by another page (target=_blank links, window.open), newest last. */
  private readonly popups: { id: string; opener: string; at: number }[] = [];

  /**
   * True inside Perch, whose patches add the `Perch` CDP domain: agent tabs then open in the
   * user's window and are held drawing (`Perch.claimTab`) instead of getting windows of their own.
   */
  perch = false;
  /**
   * What this Perch build supports beyond the domain's commands, from `Perch.getInfo`'s
   * `features`: "perch-artifact" (the artifact scheme and its loader), for example.
   */
  features: ReadonlySet<string> = new Set();

  /** Agent tabs open in Perch's hidden agent window rather than the user's tab strip. */
  get agentTabs(): boolean {
    return this.perch && this.features.has("agentTabs");
  }

  private constructor(readonly conn: CdpConnection) {
    conn.on("Target.targetCreated", (p: { targetInfo: { targetId: string; type: string; openerId?: string } }) => {
      const t = p.targetInfo;
      if (t.type === "page" && t.openerId) this.popups.push({ id: t.targetId, opener: t.openerId, at: Date.now() });
      if (this.popups.length > 50) this.popups.shift();
    });
  }

  /** Ids of pages the given tab opened at or after `since` (ms since the epoch). */
  openedBy(opener: string, since: number): string[] {
    return this.popups.filter((p) => p.opener === opener && p.at >= since).map((p) => p.id);
  }

  static async launch(opts: { userDataDir: string; executable?: string; headless?: boolean; args?: string[] }): Promise<Browser> {
    const conn = await launchChromium({
      executable: opts.executable ?? (await findChromeForTesting()),
      userDataDir: opts.userDataDir,
      headless: opts.headless ?? true,
      args: opts.args,
    });
    await conn.send("Target.setDiscoverTargets", { discover: true });
    return new Browser(conn);
  }

  /** The browser that started perchd, over a connection it handed over (src/cdp/adopt.ts). */
  static async adopt(conn: CdpConnection): Promise<Browser> {
    await conn.send("Browser.getVersion");
    await conn.send("Target.setDiscoverTargets", { discover: true });
    const browser = new Browser(conn);
    const info = await conn.send<{ perch?: boolean; features?: unknown }>("Perch.getInfo").catch(() => null);
    browser.perch = info?.perch === true;
    browser.features = new Set(Array.isArray(info?.features) ? info.features.filter((f): f is string => typeof f === "string") : []);
    return browser;
  }

  /**
   * A tab the agent opened from one of the user's tabs: moved into the hidden agent window with
   * the agent's other tabs and kept drawing. Without that window it is only claimed.
   */
  async adopt(targetId: string): Promise<void> {
    if (this.agentTabs && this.features.has("adoptAgentTab")) await this.conn.send("Perch.adoptAgentTab", { targetId }).catch(() => this.claim(targetId));
    else await this.claim(targetId);
  }

  /** Keeps a tab drawing and awake while it is in the background. Only inside Perch. */
  async claim(targetId: string): Promise<void> {
    if (this.perch) await this.conn.send("Perch.claimTab", { targetId }).catch(() => undefined);
  }

  async release(targetId: string): Promise<void> {
    if (this.perch) await this.conn.send("Perch.releaseTab", { targetId }).catch(() => undefined);
  }

  /**
   * Opens an agent tab without taking focus from the user's tab. Chromium does not draw hidden
   * background tabs, and input events wait for a drawn frame, so a plain background tab never
   * receives clicks; an unfocused window of its own stays visible to the renderer. Inside Perch
   * the tab opens in the background of the user's window instead, held drawing by
   * `Perch.claimTab`, and the session puts it in its tab group.
   */
  async newTab(url?: string): Promise<Tab> {
    let targetId: string;
    if (this.agentTabs) {
      // Perch keeps agent tabs in a hidden window of their own, listed under the toolbar's
      // Agent Tabs button, and holds them drawing (agent_tabs.h).
      ({ targetId } = await this.conn.send<{ targetId: string }>("Perch.createAgentTab", { url: "about:blank" }));
    } else {
      ({ targetId } = await this.conn.send<{ targetId: string }>(
        "Target.createTarget",
        this.perch
          ? { url: "about:blank", background: true }
          : { url: "about:blank", newWindow: true, background: true, width: AGENT_WINDOW.width, height: AGENT_WINDOW.height },
      ));
      await this.claim(targetId);
    }
    const tab = await Tab.attach(this.conn, targetId);
    await withoutPasskeys(tab);
    if (url) await tab.navigate(url);
    return tab;
  }

  async tabs(): Promise<TabInfo[]> {
    const { targetInfos } = await this.conn.send<{ targetInfos: { targetId: string; type: string; url: string; title: string }[] }>(
      "Target.getTargets",
    );
    return targetInfos.filter((t) => t.type === "page" && !Tab.hidden.has(t.targetId)).map((t) => ({ id: t.targetId, url: t.url, title: t.title }));
  }

  close(): Promise<void> {
    return this.conn.close();
  }
}
