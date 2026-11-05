import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Tab } from "../../../perchd/src/browser/tab";
import { launch, piercedText, waitFor, type Harness } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await launch();
}, 60_000);
afterAll(async () => {
  await h?.close();
});

const SHIFT = 8;

type DomNode = { nodeType: number; nodeName: string; nodeValue?: string; backendNodeId: number; children?: DomNode[]; shadowRoots?: DomNode[] };

async function center(tab: Tab, selector: string): Promise<{ x: number; y: number }> {
  return tab.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
}

async function hover(tab: Tab, point: { x: number; y: number }, modifiers = 0): Promise<void> {
  await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1, modifiers });
  await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, modifiers });
}

/** Clicks a button inside the card's closed shadow root by its label, through CDP's pierced DOM. */
async function clickButton(tab: Tab, label: string): Promise<void> {
  const { root } = await tab.send<{ root: DomNode }>("DOM.getDocument", { depth: -1, pierce: true });
  const find = (node: DomNode): DomNode | null => {
    if (node.nodeName === "BUTTON" && node.children?.some((c) => c.nodeValue === label)) return node;
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  const button = find(root);
  if (!button) throw new Error(`no button "${label}"`);
  const { model } = await tab.send<{ model: { content: number[] } }>("DOM.getBoxModel", { backendNodeId: button.backendNodeId });
  const [x1, y1, , , x3, y3] = model.content as [number, number, number, number, number, number];
  const point = { x: (x1 + x3) / 2, y: (y1 + y3) / 2 };
  for (const type of ["mousePressed", "mouseReleased"] as const) {
    await tab.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
  }
}

const cardText = (tab: Tab, needle: string) =>
  waitFor(async () => {
    const text = await piercedText(tab);
    return text.includes(needle) ? text : null;
  }, `card text "${needle}"`);

describe("link preview", () => {
  test("Shift + hover shows the linked page's title, description and cleaned address, fetched without cookies", async () => {
    const tab = await h.open(h.site.url("site.localhost", "/links.html"));
    await tab.evaluate(`document.cookie = "session=secret; path=/"`);
    await hover(tab, await center(tab, "#story"), SHIFT);
    const text = await cardText(tab, "How birds choose a perch");
    expect(text).toContain("Three seasons of field notes");
    expect(text).toContain("Field Notes");
    expect(text).toContain(h.site.url("site.localhost", "/story.html"));
    expect(text).not.toContain("utm_source");
    const fetched = h.site.hits.filter((hit) => hit.path === "/story.html");
    expect(fetched.length).toBe(1);
    expect(fetched[0]!.cookie).toBeNull();
    expect(fetched[0]!.query).toBe("");
    await tab.close();
  });

  test("hovering without Shift shows nothing", async () => {
    const tab = await h.open(h.site.url("site.localhost", "/links.html"));
    await hover(tab, await center(tab, "#story"));
    await Bun.sleep(800);
    expect(await tab.evaluate("!!document.querySelector('perch-link-preview')")).toBe(false);
    await tab.close();
  });

  test("a link to a file shows its name and type", async () => {
    const tab = await h.open(h.site.url("site.localhost", "/links.html"));
    await hover(tab, await center(tab, "#report"), SHIFT);
    expect(await cardText(tab, "report.pdf")).toContain("application/pdf");
    await tab.close();
  });

  test("Open in new tab opens the cleaned address next to the page", async () => {
    const tab = await h.open(h.site.url("site.localhost", "/links.html"));
    await hover(tab, await center(tab, "#story"), SHIFT);
    await cardText(tab, "How birds choose a perch");
    await clickButton(tab, "Open in new tab");
    const target = h.site.url("site.localhost", "/story.html");
    const opened = await waitFor(
      () => h.sw<number | null>(`chrome.tabs.query({}).then((t) => t.find((x) => x.url === ${JSON.stringify(target)} || x.pendingUrl === ${JSON.stringify(target)})?.id ?? null)`),
      "the opened tab",
    );
    await h.sw(`chrome.tabs.remove(${opened})`);
    expect(await tab.evaluate("!!document.querySelector('perch-link-preview')")).toBe(false);
    await tab.close();
  });
});
