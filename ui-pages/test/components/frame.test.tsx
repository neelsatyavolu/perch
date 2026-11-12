import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/preact";
import { PageFrame, RELEASES_URL } from "../../src/ui/frame";

afterEach(cleanup);

describe("PageFrame without perchd", () => {
  test("points to the project's GitHub releases, not an unregistered domain", () => {
    const r = render(<PageFrame api={null}><p>page</p></PageFrame>);
    expect(r.getByRole("heading", { name: "Perch's background service isn't running" })).toBeTruthy();
    const text = r.getByRole("main").textContent ?? "";
    expect(text).toContain(RELEASES_URL);
    expect(RELEASES_URL.startsWith("https://github.com/")).toBe(true);
    expect(text).not.toContain("perchbrowser.com");
  });
});

describe("PageFrame appearance", () => {
  test("repaints when the browser says the appearance changed", async () => {
    const { act, waitFor } = await import("@testing-library/preact");
    const { createFakeApi } = await import("../../src/api/fake");
    const { DEFAULT_APPEARANCE } = await import("../../src/theme/apply");
    const listeners: ((data: unknown) => void)[] = [];
    const win = window as Window & { perch?: unknown };
    win.perch = { call: async () => undefined, subscribe: (_e: string, fn: (data: unknown) => void) => (listeners.push(fn), () => undefined) };
    try {
      render(<PageFrame api={createFakeApi()}><p>page</p></PageFrame>);
      await waitFor(() => expect(listeners.length).toBe(1));
      act(() => listeners[0]!({ ...DEFAULT_APPEARANCE, theme: "graphite" }));
      expect(document.documentElement.dataset.theme).toBe("graphite");
      act(() => listeners[0]!({ theme: "dusk" }));
      expect(document.documentElement.dataset.theme).toBe("graphite");
    } finally {
      delete win.perch;
    }
  });
});
