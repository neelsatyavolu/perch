/** Renders a page inside PageFrame with a fake backend, and records navigation calls. */

import { render } from "@testing-library/preact";
import type { ComponentChildren } from "preact";
import type { PerchApi } from "../../src/api";
import { type FakeOptions, createFakeApi } from "../../src/api/fake";
import { PageFrame } from "../../src/ui/frame";

export type Nav = { what: string; detail: unknown };

export function renderWithApi(ui: ComponentChildren, options: FakeOptions = {}) {
  const nav: Nav[] = [];
  const api: PerchApi = createFakeApi({ stepMs: 0, onNavigate: (what, detail) => nav.push({ what, detail }), ...options });
  const result = render(<PageFrame api={api}>{ui}</PageFrame>);
  return { ...result, api, nav };
}
