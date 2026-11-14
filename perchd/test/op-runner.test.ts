import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onePasswordStatus, opRunner } from "../src/secure/onepassword";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A fake `op` that only sees accounts when IN_LOGIN_SHELL is set, and a fake login shell that sets it. */
function fakes() {
  const dir = mkdtempSync(join(tmpdir(), "perch-op-"));
  dirs.push(dir);
  const op = join(dir, "op");
  writeFileSync(op, `#!/bin/sh\nif [ -n "$IN_LOGIN_SHELL" ]; then echo '[{"user_uuid":"ABCDEFGHIJKLMNOPQRSTUVWXYZ","email":"a@example.com","url":"my.1password.com"}]'; else echo '[]'; fi\necho "$@" >> "${dir}/calls"\n`);
  const shell = join(dir, "zsh");
  // Like zsh -l -c 'exec "$0" "$@"' op args: the script after -c runs with op as $0.
  writeFileSync(shell, `#!/bin/sh\nshift; shift; script="$1"; shift\nexport IN_LOGIN_SHELL=1\nexec /bin/sh -c "$script" "$@"\n`);
  chmodSync(op, 0o755);
  chmodSync(shell, 0o755);
  return { op, shell, dir };
}

test("when op straight from Perch sees no accounts, it runs through the helper app, and keeps doing so", async () => {
  const { op, dir } = fakes();
  const viaHelper = opRunner(op, { PATH: "/usr/bin:/bin", IN_LOGIN_SHELL: "" }, null);
  // The fallback: the same fake op, but able to see the accounts (as Perch 1Password.app can).
  const helper = opRunner(op, { PATH: "/usr/bin:/bin", IN_LOGIN_SHELL: "1" }, null);
  const run = opRunner(op, { PATH: "/usr/bin:/bin" }, (args, timeoutMs) => helper(args, { timeoutMs }));
  expect((await onePasswordStatus(viaHelper, () => false)).accounts).toEqual([]);
  const status = await onePasswordStatus(run, () => false);
  expect(status.accounts.map((a) => a.email)).toEqual(["a@example.com"]);
  expect((await run(["vault", "list", "--format", "json"])).code).toBe(0);
  // direct (no accounts), helper, then straight to the helper for the vault list.
  expect(await Bun.file(join(dir, "calls")).text()).toBe("account list --format json\naccount list --format json\naccount list --format json\nvault list --format json\n");
});

test("a sign-in's item list, with no account list before it, also goes through the helper app, for later runners too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perch-op-"));
  dirs.push(dir);
  const op = join(dir, "op");
  // Like op inside Perch: nothing works until it runs as an app of its own.
  writeFileSync(op, `#!/bin/sh\necho "$@" >> "${dir}/calls"\nif [ -n "$IN_LOGIN_SHELL" ]; then echo '[]'; else echo "[ERROR] no account found for filter" >&2; exit 1; fi\n`);
  chmodSync(op, 0o755);
  const helper = opRunner(op, { PATH: "/usr/bin:/bin", IN_LOGIN_SHELL: "1" }, null);
  const bridge = (args: readonly string[], timeoutMs: number) => helper(args, { timeoutMs });
  const first = opRunner(op, { PATH: "/usr/bin:/bin" }, bridge);
  expect((await first(["item", "list", "--categories", "Login"])).code).toBe(0);
  const later = opRunner(op, { PATH: "/usr/bin:/bin" }, bridge);
  expect((await later(["item", "get", "x"])).code).toBe(0);
  // direct (refused), helper, then the later runner straight to the helper.
  expect(await Bun.file(join(dir, "calls")).text()).toBe("item list --categories Login\nitem list --categories Login\nitem get x\n");
});

test("a 1Password prompt the person dismissed is not tried again through the helper app", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perch-op-"));
  dirs.push(dir);
  const op = join(dir, "op");
  writeFileSync(op, `#!/bin/sh\necho "$@" >> "${dir}/calls"\necho "[ERROR] authorization prompt dismissed" >&2\nexit 1\n`);
  chmodSync(op, 0o755);
  const run = opRunner(op, { PATH: "/usr/bin:/bin" }, async () => ({ code: 0, stdout: "[]", stderr: "" }));
  expect((await run(["item", "list"])).code).toBe(1);
  expect(await Bun.file(join(dir, "calls")).text()).toBe("item list\n");
});

test("the real helper app runs op as an app of its own and passes back its output and exit code", async () => {
  const { opBridge } = await import("../src/secure/onepassword");
  const dir = mkdtempSync(join(tmpdir(), "perch-opapp-"));
  dirs.push(dir);
  const app = join(dir, "Perch 1Password.app");
  const repo = join(import.meta.dir, "..", "..", "helpers", "opbridge");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  copyFileSync(join(repo, "Info.plist"), join(app, "Contents", "Info.plist"));
  copyFileSync(join(repo, "perch-op"), join(app, "Contents", "MacOS", "perch-op"));
  chmodSync(join(app, "Contents", "MacOS", "perch-op"), 0o755);
  const op = join(dir, "op");
  writeFileSync(op, `#!/bin/sh\necho '[{"user_uuid":"ABCDEFGHIJKLMNOPQRSTUVWXYZ","email":"a@example.com"}]'\necho "to stderr" >&2\nexit 3\n`);
  chmodSync(op, 0o755);
  const result = await opBridge(app, op, process.env)(["account", "list"], 20_000);
  expect(result.code).toBe(3);
  expect(JSON.parse(result.stdout)[0].email).toBe("a@example.com");
  expect(result.stderr.trim()).toBe("to stderr");
  // Anything not named op is refused by the helper.
  const other = join(dir, "notop");
  writeFileSync(other, "#!/bin/sh\necho hi\n");
  chmodSync(other, 0o755);
  expect((await opBridge(app, other, process.env)([], 20_000)).stdout).toBe("");
}, 60_000);

test("with no shell fallback and no accounts, the status says what op printed", async () => {
  const { op } = fakes();
  const status = await onePasswordStatus(opRunner(op, { PATH: "/usr/bin:/bin" }, null));
  expect(status.accounts).toEqual([]);
  expect(status.detail).toBe('op account list printed "[]"');
});

test("when macOS keeps Perch out of the 1Password app's folder, the status says to turn on Full Disk Access", async () => {
  const { appDataBlocked, FULL_DISK_ACCESS_HELP } = await import("../src/secure/onepassword");
  const denied = () => { throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }); };
  const missing = () => { throw Object.assign(new Error("no such file"), { code: "ENOENT" }); };
  expect(appDataBlocked("/Users/x", denied)).toBe(true);
  expect(appDataBlocked("/Users/x", missing)).toBe(false);
  expect(appDataBlocked("/Users/x", () => [])).toBe(false);
  const { op } = fakes();
  const status = await onePasswordStatus(opRunner(op, { PATH: "/usr/bin:/bin" }, null), () => true);
  expect(status).toMatchObject({ accounts: [], error: FULL_DISK_ACCESS_HELP, needsFullDiskAccess: true });
});
