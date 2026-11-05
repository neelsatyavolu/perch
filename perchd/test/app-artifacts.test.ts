import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore, parseArtifactBlocks } from "../src/app/artifacts";
import { startArtifactServer, type ArtifactServer } from "../src/app/artifact-server";
import { memoryKeychain } from "../src/app/keychain";
import { Vault } from "../src/app/vault";

let dir: string;
let store: ArtifactStore;
let server: ArtifactServer;
const chatId = "11111111-1111-4111-8111-111111111111";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "perch-art-"));
  store = await ArtifactStore.load(join(dir, "artifacts"), await Vault.open(memoryKeychain(), "Default"));
  server = startArtifactServer({ store, frameAncestors: ["chrome://perch-chat"] });
});
afterAll(() => {
  server.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("saving the same title again adds a version", async () => {
  const a = await store.save({ chatId, title: "Budget", kind: "markdown", content: "# v1" });
  const b = await store.save({ chatId, title: "Budget", kind: "markdown", content: "# v2" });
  expect(b.id).toBe(a.id);
  expect(b.versions).toHaveLength(2);
  expect(store.content(a.id, 1)?.content).toBe("# v1");
  expect(store.content(a.id)?.content).toBe("# v2");
  expect(store.forChat(chatId).map((x) => x.title)).toEqual(["Budget"]);
});

test("artifacts are encrypted on disk", async () => {
  await store.save({ chatId, title: "Secret plan", kind: "html", content: "<p>launch codes</p>" });
  for (const name of readdirSync(join(dir, "artifacts"))) {
    expect(readFileSync(join(dir, "artifacts", name)).toString("latin1")).not.toContain("launch codes");
  }
});

test("kinds, sizes and image types are checked", async () => {
  await expect(store.save({ chatId, title: "x", kind: "exe" as never, content: "" })).rejects.toThrow(/kind/);
  await expect(store.save({ chatId, title: "x", kind: "image", content: "AAAA", mime: "image/svg+xml" })).rejects.toThrow(/PNG, JPEG, WebP or GIF/);
  await expect(store.save({ chatId, title: "", kind: "markdown", content: "x" })).rejects.toThrow(/title/);
  await expect(store.save({ chatId, title: "big", kind: "markdown", content: "x".repeat(3_000_000) })).rejects.toThrow(/too large/);
});

test("artifact blocks in a reply are found and replaced by markers", () => {
  const reply = [
    "Here is the chart.",
    "",
    '```artifact html "Subscriptions, last 12 months"',
    "<h1>Subs</h1>",
    "```",
    "And the script:",
    "````artifact code:python \"fetch.py\"",
    "print('```')",
    "````",
    "```js",
    "plain code stays",
    "```",
  ].join("\n");
  const parsed = parseArtifactBlocks(reply);
  expect(parsed.blocks).toEqual([
    { kind: "html", title: "Subscriptions, last 12 months", content: "<h1>Subs</h1>" },
    { kind: "code", language: "python", title: "fetch.py", content: "print('```')" },
  ]);
  expect(parsed.text).toContain("[[artifact:#0]]");
  expect(parsed.text).toContain("[[artifact:#1]]");
  expect(parsed.text).toContain("plain code stays");
  expect(parsed.text).not.toContain("<h1>Subs</h1>");
});

test("an unknown kind or an unclosed block is left as it is", () => {
  expect(parseArtifactBlocks('```artifact exe "x"\nboom\n```').blocks).toHaveLength(0);
  const open = parseArtifactBlocks('```artifact html "x"\n<p>still streaming');
  expect(open.blocks).toHaveLength(0);
  expect(open.text).toContain("still streaming");
});

test("the artifact origin sends a strict CSP and a sandbox", async () => {
  const meta = await store.save({ chatId, title: "Page", kind: "html", content: "<p>hi</p>" });
  const url = server.urlFor(meta.id, meta.versions.length);
  expect(new URL(url).origin).toBe(server.origin);
  const res = await fetch(url);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("<p>hi</p>");
  const csp = res.headers.get("content-security-policy")!;
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("sandbox allow-scripts");
  expect(csp).not.toContain("allow-same-origin");
  // No popups: window.open would carry data out to any site.
  expect(csp).not.toContain("allow-popups");
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("frame-ancestors chrome://perch-chat");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
});

test("a wrong capability, an unknown version or a bad Host is refused", async () => {
  const meta = await store.save({ chatId, title: "Page 2", kind: "html", content: "<p>x</p>" });
  const good = new URL(server.urlFor(meta.id, 1));
  const forged = new URL(good);
  forged.searchParams.set("k", "A".repeat(43));
  expect((await fetch(forged)).status).toBe(404);
  expect((await fetch(server.urlFor(meta.id, 7))).status).toBe(404);
  expect((await fetch(good, { headers: { host: "evil.example" } })).status).toBe(403);
  expect((await fetch(good, { method: "POST" })).status).toBe(405);
});

test("text kinds are served as plain text and images with their type", async () => {
  const md = await store.save({ chatId, title: "Notes", kind: "markdown", content: "<script>x</script>" });
  const res = await fetch(server.urlFor(md.id, 1));
  expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const img = await store.save({ chatId, title: "Logo", kind: "image", content: png, mime: "image/png" });
  const r = await fetch(server.urlFor(img.id, 1));
  expect(r.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await r.arrayBuffer()).toString("hex")).toBe("89504e470d0a1a0a");
});

test("removing a chat's artifacts deletes their files", async () => {
  const other = "22222222-2222-4222-8222-222222222222";
  await store.save({ chatId: other, title: "Gone", kind: "json", content: "{}" });
  const before = readdirSync(join(dir, "artifacts")).length;
  await store.removeForChat(other);
  expect(readdirSync(join(dir, "artifacts")).length).toBe(before - 1);
  expect(store.forChat(other)).toEqual([]);
});

test("a copy keeps every version under a new id and chat, and survives removing the source chat", async () => {
  const other = "22222222-2222-4222-8222-222222222222";
  const from = "33333333-3333-4333-8333-333333333333";
  const a = await store.save({ chatId: from, title: "Plan", kind: "markdown", content: "v1" });
  await store.save({ chatId: from, title: "Plan", kind: "markdown", content: "v2" });
  const copy = await store.copy(a.id, other);
  expect(copy.id).not.toBe(a.id);
  expect(copy).toMatchObject({ chatId: other, title: "Plan", kind: "markdown" });
  expect(copy.versions.map((x) => x.content)).toEqual(["v1", "v2"]);
  await store.removeForChat(from);
  expect(store.get(a.id)).toBeUndefined();
  expect(store.content(copy.id)?.content).toBe("v2");
  await expect(store.copy("missing", other)).rejects.toThrow(/no artifact/);
});
