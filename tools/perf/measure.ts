/**
 * Measures a Chromium-family browser headless over DevTools: cold start, memory idle and with
 * tabs open, and page load time, so Perch can be compared with Chrome on the same Mac.
 *
 *   bun tools/perf/measure.ts <path to app binary> [--label name] [--tabs 10] [--flag=--x ...]
 *
 * Memory is the physical footprint of every process whose command line carries this run's
 * profile folder, plus children started for it (Perch's agent). Each number is the median of runs.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const binary = args.find((a) => !a.startsWith("--"))!;
const opt = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1]! : fallback; };
const label = opt("label", binary.split("/").at(-1)!);
const tabCount = Number(opt("tabs", "10"));
const extra = args.filter((a) => a.startsWith("--flag=")).map((a) => a.slice(7));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** A page with real work in it: a long document, styles, a script and images drawn inline. */
const PAGE = `<!doctype html><meta charset=utf-8><title>perf</title><style>body{font:16px system-ui;margin:40px}section{columns:3;margin:24px 0}canvas{width:300px;height:150px}</style>
<h1>Perf page</h1>${Array.from({ length: 120 }, (_, i) => `<section><h2>Section ${i}</h2><p>${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(12)}</p><canvas id=c${i}></canvas></section>`).join("")}
<script>for(const c of document.querySelectorAll('canvas')){const x=c.getContext('2d');for(let i=0;i<200;i++){x.fillStyle='hsl('+i*3+',60%,50%)';x.fillRect(i,0,1,150)}}let s=0;for(let i=0;i<3e6;i++)s+=Math.sqrt(i);document.title='done '+s</script>`;

const server = Bun.serve({ port: 0, fetch: () => new Response(PAGE, { headers: { "content-type": "text/html" } }) });
const pageUrl = `http://127.0.0.1:${server.port}/`;

type Session = { send(method: string, params?: unknown, sessionId?: string): Promise<any>; close(): void };
async function connect(port: number): Promise<Session> {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const waiting = new Map<number, (m: any) => void>();
  ws.addEventListener("message", (e) => { const m = JSON.parse(String(e.data)); waiting.get(m.id)?.(m); waiting.delete(m.id); });
  return {
    send: (method, params = {}, sessionId) => new Promise((resolve) => { const n = ++id; waiting.set(n, (m) => resolve(m.result ?? m)); ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })); }),
    close: () => ws.close(),
  };
}

function footprintMb(profile: string): { mb: number; processes: number } {
  const ps = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 << 20 }).stdout.split("\n");
  const rows = ps.map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: Number(m![1]), ppid: Number(m![2]), cmd: m![3]! }));
  const mine = new Set(rows.filter((r) => r.cmd.includes(profile)).map((r) => r.pid));
  for (let grew = true; grew; ) { grew = false; for (const r of rows) if (!mine.has(r.pid) && mine.has(r.ppid)) { mine.add(r.pid); grew = true; } }
  let kb = 0;
  for (const pid of mine) {
    const out = spawnSync("footprint", ["-p", String(pid), "--noCategories"], { encoding: "utf8" }).stdout;
    const m = out.match(/Footprint:\s+([\d.]+)\s+(KB|MB|GB)/);
    if (m) kb += Number(m[1]) * (m[2] === "GB" ? 1 << 20 : m[2] === "MB" ? 1024 : 1);
  }
  return { mb: Math.round(kb / 1024), processes: mine.size };
}

async function launch(): Promise<{ profile: string; port: number; startMs: number; stop(): Promise<void> }> {
  const profile = mkdtempSync(join(tmpdir(), "perf-"));
  const started = performance.now();
  const child = spawn(binary, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--use-mock-keychain", "--window-size=1440,900", ...extra, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const port = await new Promise<number>((resolve, reject) => {
    let text = "";
    child.stderr.on("data", (d) => { text += String(d); const m = text.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/); if (m) resolve(Number(m[1])); });
    child.on("exit", () => reject(new Error("browser exited: " + text.slice(-300))));
    setTimeout(() => reject(new Error("browser did not start")), 30000);
  });
  const startMs = performance.now() - started;
  return {
    profile, port, startMs,
    stop: async () => { child.kill("SIGTERM"); await new Promise((r) => child.on("exit", r)); await Bun.sleep(300); rmSync(profile, { recursive: true, force: true }); },
  };
}

async function loadOnce(cdp: Session, url: string): Promise<number> {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Page.navigate", { url }, sessionId);
  let ms = 0;
  for (let i = 0; i < 200 && !ms; i++) {
    await Bun.sleep(25);
    const r = await cdp.send("Runtime.evaluate", { expression: "document.title.startsWith('done') ? performance.now() : 0", returnByValue: true }, sessionId);
    ms = r.result?.value ?? 0;
  }
  await cdp.send("Target.closeTarget", { targetId });
  return ms;
}

const starts: number[] = [], loads: number[] = [], idle: number[] = [], tabs: number[] = [], procs: number[] = [];
for (let run = 0; run < 3; run++) {
  const b = await launch();
  starts.push(b.startMs);
  const cdp = await connect(b.port);
  for (let i = 0; i < 5; i++) loads.push(await loadOnce(cdp, pageUrl));
  // Long enough for start-up work and extension workers to settle.
  await Bun.sleep(60000);
  const quiet = footprintMb(b.profile);
  idle.push(quiet.mb); procs.push(quiet.processes);
  for (let i = 0; i < tabCount; i++) await cdp.send("Target.createTarget", { url: pageUrl });
  await Bun.sleep(8000);
  tabs.push(footprintMb(b.profile).mb);
  cdp.close();
  await b.stop();
}
console.log(JSON.stringify({ label, startMs: Math.round(median(starts)), pageLoadMs: Math.round(median(loads)), idleMb: median(idle), idleProcesses: median(procs), [`with${tabCount}TabsMb`]: median(tabs) }));
server.stop(true);
process.exit(0);
