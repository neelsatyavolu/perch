/**
 * Times a large download from a local server that limits each connection's speed, the way many
 * file hosts do, to see what downloading in parallel pieces gains.
 *
 *   bun tools/perf/download.ts <binary> [--label name] [--flag=--x ...]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const binary = argv.find((a) => !a.startsWith("--"))!;
const label = argv.includes("--label") ? argv[argv.indexOf("--label") + 1]! : "browser";
const extra = argv.filter((a) => a.startsWith("--flag=")).map((a) => a.slice(7));

const SIZE = 48 * 1024 * 1024;
const PER_CONNECTION = 4 * 1024 * 1024; // bytes a second
const CHUNK = 64 * 1024;
let connections = 0;

const server = Bun.serve({
  port: 0,
  idleTimeout: 120,
  fetch(req) {
    connections++;
    const range = req.headers.get("range")?.match(/bytes=(\d+)-(\d*)/);
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Number(range[2]) : SIZE - 1;
    let sent = start;
    const body = new ReadableStream({
      async pull(controller) {
        if (sent > end) return controller.close();
        const n = Math.min(CHUNK, end - sent + 1);
        controller.enqueue(new Uint8Array(n));
        sent += n;
        await Bun.sleep((n / PER_CONNECTION) * 1000);
      },
    });
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="big.bin"', "accept-ranges": "bytes",
        etag: '"perf-v1"', "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT", "content-length": String(end - start + 1),
        ...(range ? { "content-range": `bytes ${start}-${end}/${SIZE}` } : {}),
      },
    });
  },
});

const profile = mkdtempSync(join(tmpdir(), "perf-dl-"));
const downloads = mkdtempSync(join(tmpdir(), "perf-dl-out-"));
const child = spawn(binary, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--use-mock-keychain", ...extra, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const port = await new Promise<number>((resolve) => { let t = ""; child.stderr.on("data", (d) => { t += String(d); const m = t.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/); if (m) resolve(Number(m[1])); }); });
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const send = (method: string, params: unknown = {}, sessionId?: string) => { ws.send(JSON.stringify({ id: ++id, method, params, ...(sessionId ? { sessionId } : {}) })); };
send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
await Bun.sleep(500);
const started = performance.now();
send("Target.createTarget", { url: `http://127.0.0.1:${server.port}/big.bin` });
const file = join(downloads, "big.bin");
let seconds = 0;
for (let i = 0; i < 1200; i++) {
  await Bun.sleep(100);
  if (existsSync(file) && statSync(file).size === SIZE && !readdirSync(downloads).some((n) => n.endsWith(".crdownload"))) { seconds = (performance.now() - started) / 1000; break; }
}
console.log(JSON.stringify({ label, sizeMb: SIZE >> 20, perConnectionMbps: PER_CONNECTION >> 20, seconds: Number(seconds.toFixed(1)), connectionsUsed: connections }));
child.kill("SIGTERM");
await Bun.sleep(500);
rmSync(profile, { recursive: true, force: true });
rmSync(downloads, { recursive: true, force: true });
server.stop(true);
process.exit(0);
