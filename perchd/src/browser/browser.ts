/** A Chromium instance controlled over the private pipe. */

import type { CdpConnection } from "../cdp/connection";
import { findChromeForTesting, launchChromium } from "../cdp/pipe";
import { Tab } from "./tab";

export type TabInfo = { id: string; url: string; title: string };

/** Agent windows use a common laptop size, so pages lay out as they do for people. */
const AGENT_WINDOW = { width: 1440, height: 900 };

export class Browser {
  /** Pages opened by another page (target=_blank links, window.open), newest last. */
  private readonly popups: { id: string; opener: string; at: number }[] = [];

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
    return new Browser(conn);
  }

  /**
   * Opens an agent tab without taking focus from the user's tab. Chromium does not draw hidden
   * background tabs, and input events wait for a drawn frame, so a plain background tab never
   * receives clicks; an unfocused window of its own stays visible to the renderer. (Inside Perch,
   * plan 3b keeps agent tabs drawing in the "Agent" tab group instead.)
   */
  async newTab(url?: string): Promise<Tab> {
    const { targetId } = await this.conn.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
      background: true,
      width: AGENT_WINDOW.width,
      height: AGENT_WINDOW.height,
    });
    const tab = await Tab.attach(this.conn, targetId);
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
