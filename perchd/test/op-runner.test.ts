import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("when op straight from Perch sees no accounts, it runs inside the login shell, and keeps doing so", async () => {
  const { op, shell, dir } = fakes();
  const run = opRunner(op, { PATH: "/usr/bin:/bin" }, shell);
  const status = await onePasswordStatus(run);
  expect(status.accounts.map((a) => a.email)).toEqual(["a@example.com"]);
  // Later calls go through the shell straight away.
  const again = await run(["vault", "list", "--format", "json"]);
  expect(again.code).toBe(0);
  expect(await Bun.file(join(dir, "calls")).text()).toBe("account list --format json\naccount list --format json\nvault list --format json\n");
});

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
