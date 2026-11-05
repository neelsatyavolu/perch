import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Tab } from "../../../perchd/src/browser/tab";
import { launch, piercedText, waitFor, type Harness } from "./harness";

let h: Harness;
beforeAll(async () => {
  // public.test stands in for a public web site: it is not a private name, but it reaches the fixtures.
  h = await launch(["--host-resolver-rules=MAP public.test 127.0.0.1"]);
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

/** The src of the card's image, read through CDP's pierced DOM. */
async function cardImage(tab: Tab): Promise<string | null> {
  const { root } = await tab.send<{ root: DomNode & { attributes?: string[] } }>("DOM.getDocument", { depth: -1, pierce: true });
  const find = (node: DomNode & { attributes?: string[] }): string | null => {
    if (node.nodeName === "IMG") {
      const attrs = node.attributes ?? [];
      const at = attrs.indexOf("src");
      if (at >= 0) return attrs[at + 1] ?? null;
    }
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  return find(root);
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
    // The image arrives as a data: URL from the worker; the page never requests it.
    const src = await waitFor(() => cardImage(tab), "the card image");
    expect(src.startsWith("data:image/png;base64,")).toBe(true);
    expect(await tab.evaluate<boolean>(`performance.getEntriesByType("resource").some((e) => e.name.includes("card.png"))`)).toBe(false);
    await tab.close();
  });

  test("hovering without Shift shows nothing", async () => {
    const tab = await h.open(h.site.url("site.localhost", "/links.html"));
    await hover(tab, await center(tab, "#story"));
    await Bun.sleep(800);
    expect(await tab.evaluate<boolean>("!!document.querySelector('perch-link-preview')")).toBe(false);
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
    expect(await tab.evaluate<boolean>("!!document.querySelector('perch-link-preview')")).toBe(false);
    await tab.close();
  });
});

describe("link preview on a public page never reaches private addresses", () => {
  let mark = 0;
  beforeEach(() => void (mark = h.site.hits.length));
  const loopbackHits = (path: string) => h.site.hits.slice(mark).filter((hit) => hit.host !== "public.test" && hit.path === path);

  test("a link that redirects to loopback is refused at the hop", async () => {
    const tab = await h.open(h.site.url("public.test", "/public-links.html"));
    await hover(tab, await center(tab, "#hop"), SHIFT);
    await cardText(tab, "Perch does not preview");
    expect(h.site.hits.some((hit) => hit.host === "public.test" && hit.path === "/to-local")).toBe(true);
    expect(loopbackHits("/story.html")).toHaveLength(0);
    await tab.close();
  });

  test("a loopback name with a trailing dot is refused before any request", async () => {
    const tab = await h.open(h.site.url("public.test", "/public-links.html"));
    await hover(tab, await center(tab, "#dot"), SHIFT);
    await cardText(tab, "Perch does not preview links to this kind of address.");
    expect(loopbackHits("/story.html")).toHaveLength(0);
    await tab.close();
  });

  test("an og:image that redirects to loopback is dropped without reaching it", async () => {
    const tab = await h.open(h.site.url("public.test", "/public-links.html"));
    await hover(tab, await center(tab, "#peek"), SHIFT);
    await cardText(tab, "A public page");
    await Bun.sleep(300);
    expect(await cardImage(tab)).toBeNull();
    expect(loopbackHits("/card.png")).toHaveLength(0);
    await tab.close();
  });
});

