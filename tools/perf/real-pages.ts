/**
 * Loads real pages headless and reports, per browser: time to the load event, requests made and
 * bytes transferred. Shows what the built-in blocker saves. Network-bound, so compare medians.
 *
 *   bun tools/perf/real-pages.ts <binary> [--label name] [--flag=--x ...] -- <url> [url...]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const head = argv.slice(0, split), urls = argv.slice(split + 1);
const binary = head.find((a) => !a.startsWith("--"))!;
const label = head.includes("--label") ? head[head.indexOf("--label") + 1]! : "browser";
const extra = head.filter((a) => a.startsWith("--flag=")).map((a) => a.slice(7));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const profile = mkdtempSync(join(tmpdir(), "perf-real-"));
const child = spawn(binary, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--use-mock-keychain", "--window-size=1440,900", ...extra, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const port = await new Promise<number>((resolve) => { let t = ""; child.stderr.on("data", (d) => { t += String(d); const m = t.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/); if (m) resolve(Number(m[1])); }); });
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const waiting = new Map<number, (m: any) => void>();
const listeners = new Set<(m: any) => void>();
ws.addEventListener("message", (e) => { const m = JSON.parse(String(e.data)); if (m.id) { waiting.get(m.id)?.(m); waiting.delete(m.id); } else listeners.forEach((l) => l(m)); });
const send = (method: string, params: unknown = {}, sessionId?: string) => new Promise<any>((resolve) => { const n = ++id; waiting.set(n, (m) => resolve(m.result ?? m)); ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })); });

// Give built-in extensions (the blocker) time to come up.
await Bun.sleep(6000);

async function load(url: string): Promise<{ ms: number; requests: number; kb: number }> {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  let requests = 0, bytes = 0, loaded = 0;
  const started = performance.now();
  const on = (m: any) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Network.requestWillBeSent") requests++;
    if (m.method === "Network.loadingFinished") bytes += m.params.encodedDataLength ?? 0;
    if (m.method === "Page.loadEventFired" && !loaded) loaded = performance.now() - started;
  };
  listeners.add(on);
  await send("Network.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
  await send("Page.navigate", { url }, sessionId);
  for (let i = 0; i < 300 && !loaded; i++) await Bun.sleep(100);
  await Bun.sleep(4000);
  listeners.delete(on);
  await send("Target.closeTarget", { targetId });
  return { ms: Math.round(loaded || 30000), requests, kb: Math.round(bytes / 1024) };
}

for (const url of urls) {
  const runs = [await load(url), await load(url), await load(url)];
  console.log(JSON.stringify({ label, url, loadMs: median(runs.map((r) => r.ms)), requests: median(runs.map((r) => r.requests)), transferredKb: median(runs.map((r) => r.kb)) }));
}
child.kill("SIGTERM");
await Bun.sleep(500);
rmSync(profile, { recursive: true, force: true });
process.exit(0);
