import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientRegistry } from "../src/daemon/clients";
import { FileKeychain } from "../src/daemon/keychain";
import { perchPaths } from "../src/daemon/paths";

const dir = mkdtempSync(join(tmpdir(), "perch-tokens-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("client tokens live in their own folder under PERCH_HOME", () => {
  expect(perchPaths({ PERCH_HOME: dir }).clientTokensDir).toBe(join(dir, "client-tokens"));
});

test("a token file is private to the user and round-trips", async () => {
  const store = new FileKeychain(join(dir, "round"));
  expect(await store.get("agterm")).toBeNull();
  await store.set("agterm", "a".repeat(43));
  expect(await store.get("agterm")).toBe("a".repeat(43));
  expect(statSync(join(dir, "round")).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, "round", "agterm")).mode & 0o777).toBe(0o600);
  await store.delete("agterm");
  expect(await store.get("agterm")).toBeNull();
  await store.delete("agterm");
  expect(readdirSync(join(dir, "round"))).toEqual([]);
});

test("a token file refuses bad names and bad secrets", async () => {
  const store = new FileKeychain(join(dir, "bad"));
  await expect(store.set("../escape", "a".repeat(43))).rejects.toThrow();
  await expect(store.set("ok", "short")).rejects.toThrow();
});

test("a token the perch command makes is the one perchd accepts", async () => {
  // The CLI and perchd are separate processes; they share only the folder.
  const paths = perchPaths({ PERCH_HOME: join(dir, "shared") });
  const cli = new ClientRegistry(paths.clientsFile, new FileKeychain(paths.clientTokensDir));
  const token = await cli.token("agterm");
  const daemon = new ClientRegistry(paths.clientsFile, new FileKeychain(paths.clientTokensDir));
  const verified = await daemon.verify("agterm", token);
  expect("error" in verified).toBe(false);
  expect(await daemon.verify("agterm", "b".repeat(43))).toEqual({ error: "Perch did not accept this client's token." });
});
