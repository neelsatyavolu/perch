/**
 * Where Perch keeps secrets: the macOS Keychain (spec 11.1). The real store talks to
 * /usr/bin/security and sends every secret on stdin, so it never shows up in a process list.
 * Tests use mockKeychain(); no test touches the user's Keychain.
 */

export interface KeyStore {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export type SecurityResult = { code: number; stdout: string; stderr: string };
export type SecurityRunner = (args: string[], stdin?: string) => Promise<SecurityResult>;

const SERVICE = "Perch";
const NOT_FOUND = 44;
/** security -i splits commands on spaces, so names and secrets must not contain any. */
const ACCOUNT = /^[A-Za-z0-9_.:-]{1,128}$/;
const SECRET = /^[A-Za-z0-9+/=_-]{1,4096}$/;

const runSecurity: SecurityRunner = async (args, stdin) => {
  const proc = Bun.spawn(["/usr/bin/security", ...args], { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (stdin !== undefined) {
    const sink = proc.stdin as import("bun").FileSink;
    sink.write(stdin);
    await sink.end();
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
};

function checkAccount(account: string): void {
  if (!ACCOUNT.test(account)) throw new Error("Keychain account names may only use letters, digits and _ . : -");
}

/** Plain error text without anything the command was given. */
function failure(action: string, result: SecurityResult): Error {
  const reason = result.stderr.split("\n").find((l) => l.trim())?.replace(/^security:\s*/, "").slice(0, 160) ?? `exit ${result.code}`;
  return new Error(`Could not ${action} the Keychain item: ${reason}`);
}

export function macKeychain(opts: { service?: string; run?: SecurityRunner } = {}): KeyStore {
  const service = opts.service ?? SERVICE;
  const run = opts.run ?? runSecurity;
  if (!ACCOUNT.test(service)) throw new Error("Keychain service names may only use letters, digits and _ . : -");
  return {
    async get(account) {
      checkAccount(account);
      const result = await run(["find-generic-password", "-s", service, "-a", account, "-w"]);
      if (result.code === NOT_FOUND) return null;
      if (result.code !== 0) throw failure("read", result);
      return result.stdout.replace(/\n$/, "");
    },
    async set(account, secret) {
      checkAccount(account);
      if (!SECRET.test(secret)) throw new Error("Keychain secrets must be base64 or hex text");
      const result = await run(["-i"], `add-generic-password -U -s ${service} -a ${account} -w ${secret}\n`);
      if (result.code !== 0) throw failure("save", result);
    },
    async delete(account) {
      checkAccount(account);
      const result = await run(["delete-generic-password", "-s", service, "-a", account]);
      if (result.code !== 0 && result.code !== NOT_FOUND) throw failure("delete", result);
    },
  };
}

/** An in-memory KeyStore for tests and throwaway profiles. */
export function mockKeychain(): KeyStore & { accounts(): IterableIterator<string> } {
  const items = new Map<string, string>();
  return {
    accounts: () => items.keys(),
    async get(account) {
      checkAccount(account);
      return items.get(account) ?? null;
    },
    async set(account, secret) {
      checkAccount(account);
      items.set(account, secret);
    },
    async delete(account) {
      items.delete(account);
    },
  };
}

/** The same store, kept in the profile's sealed secrets file (plan 3b, task 3) instead of the Keychain. */
export function sealedKeyStore(secrets: import("../secure/sealed-secrets").SealedSecrets): KeyStore {
  return {
    async get(account) {
      checkAccount(account);
      return secrets.get(account);
    },
    async set(account, secret) {
      checkAccount(account);
      if (!SECRET.test(secret)) throw new Error("Keychain secrets must be base64 or hex text");
      await secrets.set(account, secret);
    },
    async delete(account) {
      checkAccount(account);
      await secrets.delete(account);
    },
  };
}
