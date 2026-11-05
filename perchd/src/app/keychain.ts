/**
 * Where Perch keeps secrets: the macOS Keychain (spec 11.1). The adapter uses the `security` tool
 * and writes the secret on its stdin, so it never appears in a process list. Tests use the
 * in-memory keychain and never touch the real one.
 */

export interface Keychain {
  read(service: string, account: string): Promise<string | null>;
  write(service: string, account: string, secret: string): Promise<void>;
}

export type CommandRunner = (argv: string[], stdin?: string) => Promise<{ code: number; stdout: string }>;

/** `security` exits with this when the item does not exist. */
const NOT_FOUND = 44;
/** Names are shown in Keychain Access; secrets are base64url. Nothing else reaches the command. */
const SAFE_NAME = /^[\w .-]{1,128}$/;
const SAFE_SECRET = /^[A-Za-z0-9_-]{1,4096}$/;

const runCommand: CommandRunner = async (argv, stdin) => {
  const child = Bun.spawn(argv, { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "ignore" });
  if (stdin !== undefined && child.stdin) {
    child.stdin.write(stdin);
    await child.stdin.end();
  }
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { code, stdout };
};

export function macKeychain(run: CommandRunner = runCommand): Keychain {
  const check = (service: string, account: string) => {
    if (!SAFE_NAME.test(service) || !SAFE_NAME.test(account)) throw new Error("Keychain item names may use letters, digits, spaces, dots, dashes and underscores");
  };
  return {
    async read(service, account) {
      check(service, account);
      const { code, stdout } = await run(["/usr/bin/security", "find-generic-password", "-s", service, "-a", account, "-w"]);
      if (code === NOT_FOUND) return null;
      if (code !== 0) throw new Error(`Perch could not read "${service}" from the Keychain (security exited with ${code})`);
      return stdout.trim();
    },
    async write(service, account, secret) {
      check(service, account);
      if (!SAFE_SECRET.test(secret)) throw new Error("Keychain secrets must be base64url text");
      // `security -i` reads commands from stdin, so the secret stays out of argv.
      const { code } = await run(["/usr/bin/security", "-i"], `add-generic-password -U -s "${service}" -a "${account}" -w ${secret}\n`);
      if (code !== 0) throw new Error(`Perch could not save "${service}" in the Keychain (security exited with ${code})`);
    },
  };
}

export function memoryKeychain(): Keychain & { size(): number } {
  const items = new Map<string, string>();
  return {
    async read(service, account) {
      return items.get(`${service}\n${account}`) ?? null;
    },
    async write(service, account, secret) {
      items.set(`${service}\n${account}`, secret);
    },
    size: () => items.size,
  };
}
