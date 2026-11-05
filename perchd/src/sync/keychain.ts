/**
 * Where sync secrets live (spec 11.1): the session token, this device's private key, the sync key
 * versions and the pinned recovery public key go in the macOS Keychain, never in files or logs.
 * Values are written through `security -i` on stdin, so they never appear in a process list.
 */

export type SecretStore = {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
};

export const KEYCHAIN_SERVICE = "co.xanom.perch.sync";
export const SECRET_NAMES = ["session-token", "device-keys", "sync-keys", "recovery-public-key"] as const;

export type Runner = (args: string[], stdin?: string) => Promise<{ code: number; stdout: string }>;

const bunRunner: Runner = async (args, stdin) => {
  const proc = Bun.spawn(["/usr/bin/security", ...args], { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "ignore" });
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin);
    await proc.stdin.end();
  }
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, stdout };
};

const NAME = /^[a-z0-9-]{1,64}$/;
// The Keychain sees base64url text only, so no value can break the `security -i` command line.
const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const decode = (value: string) => Buffer.from(value, "base64url").toString("utf8");

export function macKeychain(run: Runner = bunRunner, service = KEYCHAIN_SERVICE): SecretStore {
  const check = (name: string) => {
    if (!NAME.test(name)) throw new Error("Bad Keychain item name");
  };
  return {
    async get(name) {
      check(name);
      const { code, stdout } = await run(["find-generic-password", "-s", service, "-a", name, "-w"]);
      return code === 0 ? decode(stdout.trim()) : null;
    },
    async set(name, value) {
      check(name);
      const { code } = await run(["-i"], `add-generic-password -U -s ${service} -a ${name} -w ${encode(value)}\n`);
      if (code !== 0) throw new Error("Perch could not save to the Keychain. Check that the login keychain is unlocked.");
    },
    async delete(name) {
      check(name);
      await run(["delete-generic-password", "-s", service, "-a", name]);
    },
  };
}

/** For tests and for incognito: secrets kept only in memory. */
export function memorySecretStore(): SecretStore {
  let items = new Map<string, string>();
  return {
    async get(name) {
      return items.get(name) ?? null;
    },
    async set(name, value) {
      items = new Map(items).set(name, value);
    },
    async delete(name) {
      const next = new Map(items);
      next.delete(name);
      items = next;
    },
  };
}
