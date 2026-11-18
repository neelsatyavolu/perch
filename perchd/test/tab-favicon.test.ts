import { expect, test } from "bun:test";
import { tabInfo } from "../src/app/validate";

test("a tab keeps the browser's PNG icon and drops anything else", () => {
  const base = { id: "t1", windowId: "w1", title: "Google", url: "https://www.google.com/" };
  expect(tabInfo({ ...base, favicon: "data:image/png;base64,iVBORw0KGgo=" }).favicon).toBe("data:image/png;base64,iVBORw0KGgo=");
  expect(tabInfo({ ...base, favicon: "https://evil.example/x.png" }).favicon).toBeUndefined();
  expect(tabInfo({ ...base, favicon: "data:image/svg+xml;base64,PHN2Zz4=" }).favicon).toBeUndefined();
  expect(tabInfo({ ...base, favicon: `data:image/png;base64,${"A".repeat(30_000)}` }).favicon).toBeUndefined();
});

test("a tab with a very long address or title is kept, cut short, not refused", () => {
  const url = `https://docs.example.com/edit?state=${"x".repeat(20_000)}`;
  const tab = tabInfo({ id: "t1", windowId: "w1", title: "T".repeat(5000), url });
  expect(tab.url).toBe(url.slice(0, 8000));
  expect(tab.title.length).toBe(1000);
  expect(() => tabInfo({ id: "t1", windowId: "w1", title: 5, url: "" })).toThrow();
});
