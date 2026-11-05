/**
 * The stdio transport: the server is a child process speaking newline-delimited JSON-RPC.
 *
 * It runs as the user with Perch's environment (spec 7.5), minus variables that look like
 * secrets, plus the server's own env. Perch launched from the Dock has a short PATH, so the usual
 * install folders (Homebrew, Bun, Volta, ~/.local/bin) are added to find npx, uvx and friends.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonRpcMessage, Transport } from "./jsonrpc";

export type StdioOptions = { command: string; args: string[]; env: Record<string, string>; cwd?: string; baseEnv?: Record<string, string | undefined> };

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION|AUTH)/i;
const STDERR_KEEP = 2000;
const STOP_GRACE_MS = 1500;

export function childEnv(base: Record<string, string | undefined>, own: Record<string, string>): Record<string, string> {
  const home = base.HOME ?? homedir();
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".bun/bin"), join(home, ".local/bin"), join(home, ".volta/bin"), join(home, ".cargo/bin")];
  const path = [...new Set([...(base.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(":"), ...extra])].filter(Boolean).join(":");
  const inherited = Object.entries(base).filter((e): e is [string, string] => e[1] !== undefined && !SECRET_ENV.test(e[0]));
  return { ...Object.fromEntries(inherited), PATH: path, ...own };
}

export class StdioTransport implements Transport {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private stderrTail = "";
  private stopping = false;

  constructor(private readonly opts: StdioOptions) {}

  async start(onMessage: (msg: JsonRpcMessage) => void, onClose: (error?: Error) => void): Promise<void> {
    const env = childEnv(this.opts.baseEnv ?? process.env, this.opts.env);
    const command = Bun.which(this.opts.command, { PATH: env.PATH }) ?? this.opts.command;
    try {
      this.proc = Bun.spawn([command, ...this.opts.args], { env, cwd: this.opts.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      throw new Error(`Could not start "${this.opts.command}": ${error instanceof Error ? error.message : String(error)}`);
    }
    const proc = this.proc;
    void this.readLines(proc.stdout as ReadableStream<Uint8Array>, onMessage);
    const stderrDone = this.readStderr(proc.stderr as ReadableStream<Uint8Array>);
    void proc.exited.then(async (code) => {
      if (this.stopping) return onClose();
      // Let the last stderr lines arrive: they usually say why the server stopped.
      await Promise.race([stderrDone, Bun.sleep(200)]);
      const tail = this.stderrTail.trim().split("\n").slice(-3).join(" ").slice(0, 400);
      onClose(new Error(`The server "${this.opts.command}" exited (code ${code})${tail ? `: ${tail}` : ""}`));
    });
  }

  async send(msg: JsonRpcMessage): Promise<void> {
    const stdin = this.proc?.stdin;
    if (!stdin || typeof stdin === "number") throw new Error("the server is not running");
    stdin.write(`${JSON.stringify(msg)}\n`);
    await stdin.flush();
  }

  async close(): Promise<void> {
    const proc = this.proc;
    if (!proc || this.stopping) return;
    this.stopping = true;
    const stdin = proc.stdin;
    if (stdin && typeof stdin !== "number") await Promise.resolve(stdin.end()).catch(() => undefined);
    const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(STOP_GRACE_MS).then(() => false)]);
    if (!exited) {
      proc.kill("SIGTERM");
      const gone = await Promise.race([proc.exited.then(() => true), Bun.sleep(STOP_GRACE_MS).then(() => false)]);
      if (!gone) proc.kill("SIGKILL");
    }
  }

  private async readLines(stream: ReadableStream<Uint8Array>, onMessage: (msg: JsonRpcMessage) => void): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("{")) continue; // servers sometimes print banners on stdout
        try {
          onMessage(JSON.parse(line));
        } catch {
          // A line that is not JSON is ignored, as other MCP clients do.
        }
      }
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) this.stderrTail = (this.stderrTail + decoder.decode(chunk, { stream: true })).slice(-STDERR_KEEP);
  }
}
