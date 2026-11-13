/** Shared start-up for every page: fonts, base styles, the cached theme, then the page. */

import "@fontsource/geist-sans/latin-400.css";
import "@fontsource/geist-sans/latin-500.css";
import "@fontsource/geist-mono/latin-400.css";
import "@fontsource/geist-mono/latin-500.css";
import "../styles/base.css";
import "../styles/controls.css";
import "../styles/frame.css";
import "../styles/sakura.css";
import type { ComponentType } from "preact";
import { render } from "preact";
import { applyAppearance, readCachedAppearance, readSystemPrefs } from "../theme/apply";
import { PageFrame } from "../ui/frame";

export function boot(Page: ComponentType, title: string): void {
  try {
    applyAppearance(document.documentElement, readCachedAppearance(window.localStorage), readSystemPrefs(window));
  } catch {
    // No storage: the base stylesheet's Ink + Blue stays until the API answers.
  }
  const root = document.getElementById("app");
  if (!root) throw new Error("Missing #app");
  render(
    <PageFrame title={title}>
      <Page />
    </PageFrame>,
    root,
  );
}
