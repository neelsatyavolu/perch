/**
 * Starts a page: reads where the app API is, applies the theme, then loads the page's code.
 * The browser can change the theme later by dispatching `perch:theme` on window.
 */

import { render } from "preact";
import { createClient } from "./api/client";
import { readConfig, type AccentId, type HostConfig, type ThemeId } from "./api/config";
import type { SidebarHost } from "./pages/sidebar";
import { applyTheme } from "./theme/theme";

declare global {
  interface Window {
    perchApp?: HostConfig;
    perchHost?: SidebarHost;
  }
}

export async function boot(page: "sidebar" | "chat"): Promise<void> {
  const root = document.getElementById("app")!;
  const config = readConfig({ href: location.href, replace: (url) => history.replaceState(null, "", url) }, window.perchApp);
  if (!config) {
    applyTheme(document.documentElement, "system", "blue");
    root.innerHTML = '<p class="boot-note">This page opens inside Perch.</p>';
    return;
  }
  let cleanup = applyTheme(document.documentElement, config.theme, config.accent);
  window.addEventListener("perch:theme", (e) => {
    const detail = (e as CustomEvent<{ theme: ThemeId; accent: AccentId }>).detail;
    cleanup();
    cleanup = applyTheme(document.documentElement, detail.theme, detail.accent);
  });
  const client = createClient(config.api, config.token);
  if (page === "sidebar") {
    const { Sidebar } = await import("./pages/sidebar");
    const fallbackTab = config.tabId ? { id: config.tabId, windowId: config.windowId, title: "", url: "" } : null;
    render(<Sidebar client={client} windowId={config.windowId} fallbackTab={fallbackTab} host={window.perchHost} />, root);
  } else {
    const { FullChat } = await import("./pages/full-chat");
    const params = new URLSearchParams(location.search);
    const navigate = (id: string | null) => {
      const url = new URL(location.href);
      if (id) url.searchParams.set("chat", id);
      else url.searchParams.delete("chat");
      history.replaceState(null, "", url);
    };
    render(<FullChat client={client} initialChat={params.get("chat")} onNavigate={navigate} />, root);
  }
}
