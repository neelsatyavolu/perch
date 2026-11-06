/** Launch Chromium with --remote-debugging-pipe and speak CDP over file descriptors 3 and 4. */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { CdpConnection } from "./connection";

export function encode(message: object): Buffer {
  return Buffer.concat([Buffer.from(JSON.stringify(message), "utf8"), Buffer.from([0])]);
}

/** Splits the NUL-separated JSON stream Chromium writes on fd 4. */
export class FrameDecoder {
  private buffered: Buffer[] = [];

  push(chunk: Buffer): object[] {
    const messages: object[] = [];
    let start = 0;
    for (let i = chunk.indexOf(0); i !== -1; i = chunk.indexOf(0, start)) {
      this.buffered.push(chunk.subarray(start, i));
      messages.push(JSON.parse(Buffer.concat(this.buffered).toString("utf8")));
      this.buffered = [];
      start = i + 1;
    }
    if (start < chunk.length) this.buffered.push(chunk.subarray(start));
    return messages;
  }
}

const RETIRED: unknown[] = [];

export type LaunchOptions = { executable: string; userDataDir: string; headless: boolean; args?: string[] };

/**
 * Command-line flags for a browser perchd drives. Agent windows are often covered by the user's
 * own windows; Chromium stops drawing covered windows, and mouse input, wheel scrolls and
 * screenshots then wait for a frame that never comes ("the page stopped responding").
 */
export function chromiumArgs(opts: LaunchOptions): string[] {
  return [
    "--remote-debugging-pipe",
    `--user-data-dir=${opts.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    ...(opts.headless ? ["--headless=new"] : []),
    ...(opts.args ?? []),
    "about:blank",
  ];
}

export async function launchChromium(opts: LaunchOptions): Promise<CdpConnection> {
  const args = chromiumArgs(opts);
  const child = spawn(opts.executable, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  const toBrowser = child.stdio[3] as Writable;
  const fromBrowser = child.stdio[4] as Readable;
  if (process.env.PERCH_CHROME_LOG) {
    const { createWriteStream } = await import("node:fs");
    child.stderr?.pipe(createWriteStream(`${process.env.PERCH_CHROME_LOG}.${child.pid}.log`));
  } else child.stderr?.resume();

  // Our ends of a finished browser's pipes are never closed or collected: under Bun, their late
  // cleanup can close descriptor numbers a newer browser's pipes have reused, which makes that
  // browser exit mid-session. Two descriptors per launch is a small, bounded cost.
  RETIRED.push(child, toBrowser, fromBrowser);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (child.pid) {
    const watcher = watchForParentExit(child.pid);
    child.once("exit", () => watcher.kill());
  }
  const conn = new CdpConnection(
    (message) => {
      if (toBrowser.destroyed || !toBrowser.writable) throw new Error("browser closed");
      toBrowser.write(encode(message));
    },
    async () => {
      try {
        await Promise.race([conn.send("Browser.close"), exited]);
      } catch {
        // The browser may already be gone.
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(timer);
    },
  );
  conn.pid = child.pid;
  const onStreamError = (error: Error) => conn.fail(new Error(`browser closed (${error.message})`));
  toBrowser.on("error", onStreamError);
  fromBrowser.on("error", onStreamError);
  const decoder = new FrameDecoder();
  fromBrowser.on("data", (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) conn.handle(message);
  });
  child.once("exit", (code, signal) => conn.fail(new Error(`browser closed (exit ${code ?? signal})`)));
  child.once("error", (error) => conn.fail(error));

  await conn.send("Browser.getVersion");
  return conn;
}

/**
 * A browser normally quits when our end of its pipe closes, but one that has stopped responding
 * never reads it, and outlived its parent for hours in a benchmark run. A small shell process
 * kills the browser once this process is gone, however it ended.
 */
function watchForParentExit(browserPid: number) {
  const script = `while kill -0 ${process.pid} 2>/dev/null; do sleep 2; done; kill -9 ${browserPid} 2>/dev/null`;
  const watcher = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" });
  watcher.unref();
  return watcher;
}

const CFT_ROOT = join(homedir(), ".cache", "perch-cft", "chrome");
const CFT_BINARY = "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

/** The Chrome for Testing binary used in development: PERCH_CHROME, else the newest install. */
export async function findChromeForTesting(): Promise<string> {
  const fromEnv = process.env.PERCH_CHROME;
  if (fromEnv) return fromEnv;
  const versions = existsSync(CFT_ROOT) ? readdirSync(CFT_ROOT).filter((d) => d.startsWith("mac_arm-")) : [];
  const newest = versions
    .map((dir) => ({ dir, parts: dir.slice("mac_arm-".length).split(".").map(Number) }))
    .sort((a, b) => {
      for (let i = 0; i < 4; i++) if ((a.parts[i] ?? 0) !== (b.parts[i] ?? 0)) return (b.parts[i] ?? 0) - (a.parts[i] ?? 0);
      return 0;
    })[0];
  if (!newest) throw new Error("Chrome for Testing not found; run: bunx @puppeteer/browsers install chrome@stable --path ~/.cache/perch-cft");
  return join(CFT_ROOT, newest.dir, CFT_BINARY);
}
