/**
 * The macOS Keychain, behind a small interface so tests use an in-memory fake.
 *
 * Reading another browser's "<Browser> Safe Storage" item makes macOS show its own prompt
 * ("perchd wants to use your confidential information stored in ..."); the user can allow or
 * deny it. Values are passed to `security` on stdin, never on the command line, so they do not
 * show up in `ps`.
 */

import { ImportError } from "./types";

export interface Keychain {
  /** The item's secret, or null when no such item exists. Throws ImportError("keychain-denied") when the user says no. */
  find(service: string, account?: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
  remove(service: string, account: string): Promise<void>;
}

const SECURITY = "/usr/bin/security";
/** errSecItemNotFound as `security` reports it. */
const NOT_FOUND = 44;

type Run = (args: string[], stdin?: string) => Promise<{ code: number; stdout: string }>;

const spawnSecurity: Run = async (args, stdin) => {
  const proc = Bun.spawn([SECURITY, ...args], { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "ignore" });
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin);
    await proc.stdin.end();
  }
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout };
};

function quote(s: string): string {
  if (!/^[\w .:@/+=-]*$/.test(s)) throw new ImportError("Keychain names and values may only use plain characters.", "invalid");
  return `"${s}"`;
}

export function macKeychain(run: Run = spawnSecurity): Keychain {
  return {
    async find(service, account) {
      const args = ["find-generic-password", "-w", "-s", service, ...(account ? ["-a", account] : [])];
      const { code, stdout } = await run(args);
      if (code === 0) return stdout.replace(/\n$/, "");
      if (code === NOT_FOUND) return null;
      throw new ImportError(`macOS did not allow reading "${service}" from the Keychain. Choose Allow when macOS asks, or skip this data.`, "keychain-denied");
    },
    async set(service, account, value) {
      const { code } = await run(["-i"], `add-generic-password -U -s ${quote(service)} -a ${quote(account)} -w ${quote(value)}\n`);
      if (code !== 0) throw new ImportError(`Could not save "${service}" to the Keychain.`, "keychain-denied");
    },
    async remove(service, account) {
      const { code } = await run(["delete-generic-password", "-s", service, "-a", account]);
      if (code !== 0 && code !== NOT_FOUND) throw new ImportError(`Could not remove "${service}" from the Keychain.`, "keychain-denied");
    },
  };
}

/** In-memory Keychain for tests. `deny` lists services the "user" refuses. */
export function memoryKeychain(items: Record<string, string> = {}, deny: readonly string[] = []): Keychain & { readonly asked: readonly string[] } {
  const store = new Map(Object.entries(items));
  const asked: string[] = [];
  const key = (service: string, account?: string) => (account ? `${service}/${account}` : service);
  return {
    asked,
    async find(service, account) {
      asked.push(service);
      if (deny.includes(service)) throw new ImportError(`macOS did not allow reading "${service}" from the Keychain.`, "keychain-denied");
      return store.get(key(service, account)) ?? store.get(service) ?? null;
    },
    async set(service, account, value) {
      store.set(key(service, account), value);
    },
    async remove(service, account) {
      store.delete(key(service, account));
    },
  };
}
