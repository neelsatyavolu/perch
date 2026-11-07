import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { importPages } from "../src/app/pages/import";
import { memoryPages } from "../src/app/pages/memory";
import { modelsPages, providerAllowed } from "../src/app/pages/models";
import { permissionsPages } from "../src/app/pages/permissions";
import { policyPages } from "../src/app/pages/policy";
import type { PagesDeps } from "../src/app/pages/deps";
import { AppError } from "../src/app/runs";
import { ClientRegistry } from "../src/daemon/clients";
import { MemoryKeychain } from "../src/daemon/keychain";
import type { Policy } from "../src/policy/policy";
import { tempProfile } from "./helpers";

const tmp = tempProfile();
afterAll(() => tmp.cleanup());

/** Pages deps with only what these handlers touch, under a policy the test sets. */
async function deps(policy: Policy, errors: { name: string; message: string }[] = []) {
  let state = { mode: "guard" as const, siteRules: [] as never[] };
  const clients = new ClientRegistry(join(tmp.dir, `clients-${Math.random()}.json`), new MemoryKeychain());
  await clients.verify("codex", await clients.token("codex"));
  let memorySettings = { extraction: false, paused: false, dreaming: false, episodicRetentionDays: null };
  const data = {
    memory: { settings: () => memorySettings, changes: async () => [] },
    memoryApi: { updateSettings: async (patch: object) => ((memorySettings = { ...memorySettings, ...patch }), { ok: true, data: memorySettings }) },
  };
  return {
    state: { get: async () => state, update: async (fn: (s: typeof state) => typeof state) => (state = fn(state)) },
    clients,
    data: async () => data,
    importer: { home: join(tmp.dir, "home"), target: { userDataDir: join(tmp.dir, "user-data") }, keychain: {} },
    policy: { current: () => policy, errors: () => errors },
  } as unknown as PagesDeps;
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return { status: error.status, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

test("setPermissionMode above the cap is refused by perchd, not only greyed out", async () => {
  const p = permissionsPages(await deps({ MaxPermissionMode: "guard" }));
  expect(await refusal(p.setPermissionMode(["skip"]))).toEqual({ status: 403, message: "Managed by your organization" });
  expect((await p.setPermissionMode(["ask"])).mode).toBe("ask");
  expect((await p.getPermissions([])).maxMode).toBe("guard");
  expect((await refusal(p.setClientMode(["codex", "skip"]))).status).toBe(403);
});

test("setMemorySettings cannot turn memory on under MemoryEnabled false", async () => {
  const m = memoryPages(await deps({ MemoryEnabled: false }), () => undefined);
  expect((await refusal(m.setMemorySettings([{ extraction: true }]))).status).toBe(403);
  expect((await refusal(m.setMemorySettings([{ dreaming: true }]))).status).toBe(403);
  expect(await m.setMemorySettings([{ extraction: false }])).toMatchObject({ extraction: false, dreaming: false });
});

test("models: providers the company does not allow are hidden and refused", async () => {
  const policy: Policy = { AllowedModelProviders: ["anthropic", "custom"] };
  expect(providerAllowed("anthropic", policy)).toBe(true);
  expect(providerAllowed("openai", policy)).toBe(false);
  expect(providerAllowed("codex", { ModelEndpoints: [{ name: "Co", kind: "openai", url: "https://m.example.com/v1" }] })).toBe(false);
  const d = await deps(policy);
  const models = modelsPages({ ...d, models: { registry: async () => ({ listProviders: async () => [] }) } } as unknown as PagesDeps);
  expect((await refusal(models.signIn(["chatgpt"]))).status).toBe(403);
  expect((await refusal(models.connectProvider([{ kind: "api-key", provider: "openai", key: "x".repeat(20) }]))).status).toBe(403);
});

test("import refuses a browser or data type the company does not allow", async () => {
  const i = importPages(await deps({ ImportEnabled: { data: ["bookmarks"] } }));
  expect((await refusal(i.startImport([{ browser: "chrome", profile: "Default", kinds: ["passwords"] }]))).status).toBe(403);
  expect(await i.detectBrowsers([])).toEqual([]);
});

test("getPolicy reports what is managed and its problems; an unmanaged Mac reports nothing", async () => {
  expect(await policyPages(await deps({})).getPolicy([])).toEqual({ managed: false, values: {}, errors: [] });
  const state = await policyPages(await deps({ MaxPermissionMode: "guard" }, [{ name: "UpdateDelayDays", message: "UpdateDelayDays must be at most 30, so Perch ignores it" }])).getPolicy([]);
  expect(state).toEqual({ managed: true, values: { MaxPermissionMode: "guard" }, errors: [{ name: "UpdateDelayDays", message: "UpdateDelayDays must be at most 30, so Perch ignores it" }] });
});

test("an unmanaged Mac changes nothing in Settings", async () => {
  const p = permissionsPages(await deps({}));
  expect((await p.setPermissionMode(["skip"])).mode).toBe("skip");
  expect((await p.getPermissions([])).maxMode).toBeNull();
  const m = memoryPages(await deps({}), () => undefined);
  expect(await m.setMemorySettings([{ extraction: true, dreaming: true }])).toMatchObject({ extraction: true, dreaming: true });
});
