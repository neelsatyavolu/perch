/** A Chromium instance controlled over the private pipe. */

import type { CdpConnection } from "../cdp/connection";
import { findChromeForTesting, launchChromium } from "../cdp/pipe";
import { Tab } from "./tab";

export type TabInfo = { id: string; url: string; title: string };

export class Browser {
  private constructor(readonly conn: CdpConnection) {}

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

  /** Opens a background tab, so the user's current tab keeps focus. */
  async newTab(url?: string): Promise<Tab> {
    const { targetId } = await this.conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true });
    const tab = await Tab.attach(this.conn, targetId);
    if (url) await tab.navigate(url);
    return tab;
  }

  async tabs(): Promise<TabInfo[]> {
    const { targetInfos } = await this.conn.send<{ targetInfos: { targetId: string; type: string; url: string; title: string }[] }>(
      "Target.getTargets",
    );
    return targetInfos.filter((t) => t.type === "page").map((t) => ({ id: t.targetId, url: t.url, title: t.title }));
  }

  close(): Promise<void> {
    return this.conn.close();
  }
}
