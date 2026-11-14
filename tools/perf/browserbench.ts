/**
 * Runs the public browser benchmarks (Speedometer 3.1, JetStream 2.2, MotionMark 1.3.1) in
 * Chromium-family browsers, headed and in front, so Perch can be compared with other browsers on
 * the same Mac. Every run gets a fresh profile and the same flags. Rounds go browser by browser in a
 * rotated order, so slow drift (heat, background work) lands on every browser alike; the summary
 * reports the median of the rounds.
 *
 *   bun tools/perf/browserbench.ts [--rounds 3] [--suites speedometer,jetstream,motionmark]
 *                                  [--browsers perch,chrome,brave,aside] [--out dir]
 *                                  [--binary "name=/path/to/binary|--flag|--flag" ...]
 *
 * A run where the page was hidden at any point (a window covered it, the display slept) is thrown
 * away and tried again, since hidden pages are throttled. Results go to <out>/runs.jsonl and
 * <out>/summary.md; a run already in runs.jsonl is not run again, so a stopped run can resume.
 *
 * BENCH_LOCK=<path> makes each run hold that directory (mkdir is atomic) while it measures, so other
 * heavy work that takes the same lock (test suites, builds) runs between benchmark runs, not during.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1]! : fallback; };

const KNOWN: Record<string, string> = {
  perch: "/Applications/Perch.app/Contents/MacOS/Perch",
  chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  brave: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  aside: "/Applications/Aside.app/Contents/MacOS/Aside",
  edge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
};
/** Extra flags for a browser, so one binary can run as variants, e.g. "perch-noext=<path>|--disable-extensions". */
const FLAGS: Record<string, string[]> = {};
for (let i = 0; i < argv.length; i++) if (argv[i] === "--binary") {
  const eq = argv[i + 1]!.indexOf("=");
  const [path, ...flags] = argv[i + 1]!.slice(eq + 1).split("|");
  KNOWN[argv[i + 1]!.slice(0, eq)] = path!;
  FLAGS[argv[i + 1]!.slice(0, eq)] = flags;
}

const rounds = Number(opt("rounds", "3"));
const suiteNames = opt("suites", "speedometer,jetstream,motionmark").split(",");
const browsers = opt("browsers", "perch,chrome,brave,aside").split(",").filter((b) => existsSync(KNOWN[b] ?? ""));
const out = opt("out", join(import.meta.dir, "results", new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")));
const LOCK = process.env.BENCH_LOCK;
mkdirSync(out, { recursive: true });

type Suite = { url: string; timeoutMin: number; start?: string; ready?: string; result: string; detail?: string };
/** Each expression returns "" until there is something to report. */
const SUITES: Record<string, Suite> = {
  speedometer: {
    url: "https://browserbench.org/Speedometer3.1/?startAutomatically",
    timeoutMin: 15,
    result: `(() => { const e = document.querySelector('#result-number'); const t = e && e.textContent.trim(); return location.hash === '#summary' && t ? t : ''; })()`,
    // Each subtest's time, from the page's details view.
    detail: `(() => { location.hash = '#details'; const d = document.querySelector('#details'); return d ? d.innerText : ''; })()`,
  },
  jetstream: {
    url: "https://browserbench.org/JetStream2.2/",
    timeoutMin: 25,
    ready: `!!document.querySelector('#status a.button')`,
    start: `JetStream.start(), true`,
    result: `(() => { const e = document.querySelector('#result-summary .score'); return e ? e.textContent.trim() : ''; })()`,
  },
  motionmark: {
    url: "https://browserbench.org/MotionMark1.3.1/",
    timeoutMin: 25,
    ready: `(() => { const b = document.querySelector('#start-button'); return !!b && !b.disabled; })()`,
    start: `benchmarkController.startBenchmark(), true`,
    result: `(() => { const s = document.querySelector('#results.selected .score'); return s ? s.textContent.trim() : ''; })()`,
  },
};

/**
 * Waits for the charger, no heat warning and a mostly idle CPU, so a run isn't measuring other work.
 * Gives up on the CPU after thirty minutes (work outside this Mac's lock can keep it busy); each run
 * records the load it started under.
 */
async function waitUntilQuiet(): Promise<void> {
  for (let waited = 0; ; waited++) {
    const batt = Bun.spawnSync(["pmset", "-g", "batt"]).stdout.toString();
    const therm = Bun.spawnSync(["pmset", "-g", "therm"]).stdout.toString();
    const onAC = batt.includes("AC Power");
    const hot = /(thermal|performance) warning level[^0-9]*[1-9]/i.test(therm) || /CPU_Speed_Limit\s*=\s*([0-7]?\d)\b/.test(therm);
    const busy = loadavg()[0]! > cpus().length * 0.25;
    if (onAC && !hot && (!busy || waited >= 120)) return;
    if (waited % 4 === 0) console.error(`waiting: ${!onAC ? "on battery " : ""}${hot ? "heat warning " : ""}${busy ? `load ${loadavg()[0]!.toFixed(1)}` : ""}`);
    await Bun.sleep(15_000);
  }
}

/** Takes BENCH_LOCK for one run, waiting for whoever holds it; returns the release. */
async function takeLock(): Promise<() => void> {
  if (!LOCK) return () => {};
  for (;;) {
    try { mkdirSync(LOCK); writeFileSync(join(LOCK, "owner"), `browserbench ${process.pid}\n`); break; } catch { await Bun.sleep(5000); }
  }
  return () => rmSync(LOCK, { recursive: true, force: true });
}

type Cdp = { send(method: string, params?: unknown, sessionId?: string): Promise<any>; close(): void };
async function connect(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
  let id = 0;
  const waiting = new Map<number, (m: any) => void>();
  ws.addEventListener("message", (e) => { const m = JSON.parse(String(e.data)); if (m.id) { waiting.get(m.id)?.(m); waiting.delete(m.id); } });
  return {
    send: (method, params = {}, sessionId) => new Promise((resolve) => { const n = ++id; waiting.set(n, (m) => resolve(m.result ?? m)); ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })); }),
    close: () => ws.close(),
  };
}

async function launch(binary: string, flags: string[]) {
  const profile = mkdtempSync(join(tmpdir(), "bb-"));
  // Perch starts its own perchd; keep it away from the user's real Perch data and Keychain items.
  const home = mkdtempSync("/private/tmp/pb-");
  const env = { ...process.env, PERCH_HOME: home, PERCH_KEYCHAIN_SUFFIX: ".bench" };
  const child = spawn(binary, [
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
    "--use-mock-keychain", "--window-size=1600,1000", "--window-position=0,0", ...flags, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], env });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let text = "";
    child.stderr!.on("data", (d) => { text += String(d); const m = text.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]!); });
    child.on("exit", () => reject(new Error("browser exited: " + text.slice(-300))));
    setTimeout(() => reject(new Error("browser did not start")), 30_000);
  });
  return {
    wsUrl,
    stop: async () => {
      child.kill("SIGTERM");
      await Promise.race([new Promise((r) => child.on("exit", r)), Bun.sleep(10_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
      await Bun.sleep(1500);
      rmSync(profile, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function runOne(browser: string, suiteName: string): Promise<{ score: number; raw: string; hidden: boolean; seconds: number; detail?: string }> {
  const suite = SUITES[suiteName]!;
  const b = await launch(KNOWN[browser]!, FLAGS[browser] ?? []);
  const cdp = await connect(b.wsUrl);
  const started = Date.now();
  try {
    // One tab only: close whatever the browser opened at start.
    const { targetInfos } = await cdp.send("Target.getTargets");
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    for (const t of targetInfos as { targetId: string; type: string }[]) if (t.type === "page") await cdp.send("Target.closeTarget", { targetId: t.targetId });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const evaluate = async (expression: string) => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId))?.result?.value;
    await cdp.send("Page.enable", {}, sessionId);
    // Counts every moment the page is hidden, from the first script on.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `if (window === top) addEventListener('visibilitychange', () => { if (document.hidden) localStorage.setItem('bb-hidden', '1'); });` }, sessionId);
    await cdp.send("Page.bringToFront", {}, sessionId);
    await cdp.send("Page.navigate", { url: suite.url }, sessionId);
    const deadline = started + suite.timeoutMin * 60_000;
    if (suite.ready) {
      while (!(await evaluate(suite.ready))) { if (Date.now() > deadline) throw new Error("never became ready"); await Bun.sleep(1000); }
      await Bun.sleep(2000);
      await cdp.send("Page.bringToFront", {}, sessionId);
      await evaluate(suite.start!);
    }
    let raw = "";
    while (!(raw = (await evaluate(suite.result)) ?? "")) { if (Date.now() > deadline) throw new Error("timed out"); await Bun.sleep(5000); }
    const hidden = (await evaluate(`localStorage.getItem('bb-hidden') === '1' || document.hidden`)) === true;
    let detail: string | undefined;
    if (suite.detail) { await evaluate(suite.detail); await Bun.sleep(1500); detail = String((await evaluate(suite.detail)) ?? "").slice(0, 20000); }
    return { score: Number.parseFloat(raw), raw, hidden, seconds: Math.round((Date.now() - started) / 1000), detail };
  } finally {
    cdp.close();
    await b.stop();
  }
}

const runsFile = join(out, "runs.jsonl");
const done = existsSync(runsFile) ? readFileSync(runsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
/** A run that started with more than half the cores busy measured other work too; it counts as not run. */
const MAX_LOAD = cpus().length / 2;
const valid = (r: { error?: unknown; hidden?: unknown; load?: number }) => !r.error && !r.hidden && (r.load ?? Infinity) <= MAX_LOAD;
const have = (browser: string, suite: string, round: number) => done.some((r) => r.browser === browser && r.suite === suite && r.round === round && valid(r));

const caffeinate = spawn("caffeinate", ["-dimsu", "-w", String(process.pid)], { stdio: "ignore" });
try {
  for (let round = 0; round < rounds; round++) {
    const order = browsers.map((_, i) => browsers[(i + round) % browsers.length]!);
    for (const suite of suiteNames) for (const browser of order) {
      if (have(browser, suite, round)) continue;
      for (let attempt = 0; attempt < 5; attempt++) {
        await waitUntilQuiet();
        const release = await takeLock();
        const row: Record<string, unknown> = { browser, suite, round, attempt };
        try {
          row.at = new Date().toISOString();
          row.load = Number(loadavg()[0]!.toFixed(1));
          Object.assign(row, await runOne(browser, suite));
        } catch (e) { row.error = String((e as Error).message ?? e); } finally { release(); }
        // Leave the lock free for a moment, so work waiting on it gets a turn between runs.
        if (LOCK) await Bun.sleep(15_000);
        appendFileSync(runsFile, JSON.stringify(row) + "\n");
        console.log(JSON.stringify({ ...row, detail: undefined }));
        if (valid(row)) break;
      }
    }
  }
} finally {
  caffeinate.kill();
}

const rows = readFileSync(runsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter(valid);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const lines = [`# Browser benchmarks`, ``, `Median of ${rounds} rounds, fresh profile per run, headed. Higher is better.`, ``, `| Browser | ${suiteNames.join(" | ")} |`, `|---|${suiteNames.map(() => "---").join("|")}|`];
for (const browser of browsers) lines.push(`| ${browser} | ${suiteNames.map((s) => { const xs = rows.filter((r) => r.browser === browser && r.suite === s).map((r) => r.score); return xs.length ? `${median(xs).toFixed(2)} (n=${xs.length})` : "–"; }).join(" | ")} |`);
writeFileSync(join(out, "summary.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
process.exit(0);
