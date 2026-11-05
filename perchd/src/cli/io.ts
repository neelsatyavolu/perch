/** What a CLI command needs from the outside world, so tests can run commands in-process. */

import { existsSync, mkdirSync, openSync } from "node:fs";
import { basename } from "node:path";
import type { ApproveAsk } from "../daemon/protocol";
import { ClientRegistry } from "../daemon/clients";
import { MacKeychain, type Keychain } from "../daemon/keychain";
import { perchPaths, type PerchPaths } from "../daemon/paths";
import { connect, DaemonNotRunning, type DaemonClient } from "./client";
import { selfCommand } from "./self";

export type CliIO = {
  env: Record<string, string | undefined>;
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  keychain?: Keychain;
  /** Start perchd when it is not running (the default for the real command). */
  autostart?: boolean;
  /** Asks a yes/no question on the terminal; absent when there is no terminal. */
  ask?(question: string): Promise<boolean>;
};

export type SessionOptions = {
  client?: string;
  session?: string;
  title?: string;
  agent?: string;
  persistent?: boolean;
  onEnd?: "close" | "sleep";
  /** Answers approvals; defaults to asking on the terminal when there is one. */
  onApprove?: (ask: ApproveAsk) => Promise<boolean>;
};

const START_TIMEOUT_MS = 15_000;

export function pathsFor(io: CliIO): PerchPaths {
  return perchPaths(io.env);
}

/** Starts `perch serve` in the background, logging to perchd.log, and waits for its socket. */
async function startDaemon(io: CliIO, attempt: () => Promise<DaemonClient>): Promise<DaemonClient> {
  const paths = pathsFor(io);
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const log = openSync(paths.logFile, "a", 0o600);
  const child = Bun.spawn([...selfCommand(), "serve"], { env: { ...process.env, ...io.env }, stdin: "ignore", stdout: log, stderr: log });
  child.unref();
  const started = Date.now();
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof DaemonNotRunning) || Date.now() - started > START_TIMEOUT_MS) throw error;
      if (child.exitCode !== null) throw new Error(`perchd could not start; see ${paths.logFile}`);
      await Bun.sleep(100);
    }
  }
}

/** Connects to perchd as a client, starting it first when allowed. */
export async function openDaemon(io: CliIO, opts: SessionOptions = {}): Promise<DaemonClient> {
  const paths = pathsFor(io);
  // Nothing to talk to: say so before touching the Keychain.
  if (io.autostart === false && !existsSync(paths.socket)) throw new DaemonNotRunning();
  const client = opts.client ?? "cli";
  const registry = new ClientRegistry(paths.clientsFile, io.keychain ?? new MacKeychain());
  const token = await registry.token(client);
  const ask = io.ask;
  const attempt = () =>
    connect({
      socket: paths.socket,
      hello: {
        client,
        token,
        session: opts.session ?? io.env.PERCH_SESSION ?? "default",
        title: opts.title ?? basename(io.cwd),
        agent: opts.agent ?? client,
        persistent: opts.persistent ?? false,
        onEnd: opts.onEnd ?? "close",
      },
      onApprove: opts.onApprove ?? (ask ? (a: ApproveAsk) => ask(`Allow: ${a.summary}?`) : undefined),
    });
  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof DaemonNotRunning) || io.autostart === false) throw error;
    return startDaemon(io, attempt);
  }
}
