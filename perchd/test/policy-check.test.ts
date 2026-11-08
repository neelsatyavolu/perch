import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  asExpected, buildKind, fill, findPolicy, judgePolicy, LOCAL_TEST_POLICIES, loadCases, requireDevBuild, resultsTable, updateDoc, writeLocalState,
} from "../scripts/policy-check";
import { tempProfile } from "./helpers";

const tmp = tempProfile();
afterAll(() => tmp.cleanup());

test("writes the test policies into Local State as mandatory machine policies from the platform", async () => {
  await writeLocalState(tmp.dir, [{ name: "URLBlocklist", value: ["example.com"] }]);
  const state = JSON.parse(readFileSync(join(tmp.dir, "Local State"), "utf8"));
  expect(JSON.parse(state[LOCAL_TEST_POLICIES])).toEqual([{ level: 1, scope: 1, source: 5, name: "URLBlocklist", value: ["example.com"] }]);
});

test("refuses a release build", () => {
  const official = { argsGn: () => "is_debug = false\nis_official_build = true\n", codesign: () => "" };
  const dev = { argsGn: () => "is_debug = false\n", codesign: () => "" };
  const signed = { argsGn: () => null, codesign: () => "Authority=Developer ID Application: Example (TEAM)\n" };
  expect(() => requireDevBuild("/out/Release/Perch.app", official)).toThrow("Use a dev build");
  expect(buildKind("/out/Dev/Perch.app", dev)).toBe("dev");
  expect(buildKind("/Applications/Perch.app", signed)).toBe("official");
});

test("every case is well formed, and ignored cases are the Google-only ones", () => {
  const cases = loadCases();
  expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  for (const c of cases) {
    expect(c.policies.length).toBeGreaterThan(0);
    expect(["navigation", "download", "proxy", "policy"]).toContain(c.check.kind);
  }
  expect(cases.filter((c) => c.expect === "ignored").flatMap((c) => c.policies.map((p) => p.name)).sort()).toEqual(["BrowserSignin", "CloudManagementEnrollmentToken", "MetricsReportingEnabled"]);
  // Chromium's sensitive policies cannot come from test policies; each such case says why.
  for (const c of cases.filter((x) => x.expect === "mdm-only")) expect(c.note).toContain("managed Mac");
});

test("an mdm-only case passes only when the policy page reports it blocked", () => {
  const base = { id: "m", policy: "MetricsReportingEnabled", expected: "mdm-only" as const };
  expect(asExpected({ ...base, status: "fails", detail: "MetricsReportingEnabled: This policy is blocked, its value will be ignored." })).toBe(true);
  expect(asExpected({ ...base, status: "fails", detail: "browser closed" })).toBe(false);
  expect(asExpected({ ...base, id: "w", expected: "works", status: "works", detail: "applied" })).toBe(true);
});

const TREE = join(process.env.PERCH_CHROMIUM_DIR ?? "/Users/Shared/chromium-perch.noindex", "src", "components", "policy", "resources", "templates", "policies.yaml");

test.skipIf(!existsSync(TREE))("every case names a policy that exists in the pinned tree", () => {
  const yaml = readFileSync(TREE, "utf8");
  const known = new Set([...yaml.matchAll(/^\s+\d+:\s+(\w+)\s*$/gm)].map((m) => m[1]));
  for (const c of loadCases()) for (const p of c.policies) expect(`${p.name}: ${known.has(p.name)}`).toBe(`${p.name}: true`);
});

test("values get the local server and proxy addresses", () => {
  expect(fill({ ProxyServer: "{proxy}", list: ["{server}/a", 3] }, { proxy: "127.0.0.1:9", server: "http://127.0.0.1:8" })).toEqual({ ProxyServer: "127.0.0.1:9", list: ["http://127.0.0.1:8/a", 3] });
});

test("reads the policy page's report: applied, ignored in Perch, or a problem", () => {
  const report = { policyValues: { chrome: { name: "Chrome policies", policies: {
    URLBlocklist: { value: ["x"], level: "mandatory" },
    BrowserSignin: { value: 0, error: "This policy is blocked, its value will be ignored." },
    Bad: { value: 1, error: "Schema validation error" },
  } } } };
  expect(judgePolicy(findPolicy(report, "URLBlocklist")).status).toBe("works");
  expect(judgePolicy(findPolicy(report, "BrowserSignin"), "BrowserSignin").status).toBe("ignored");
  expect(judgePolicy(findPolicy(report, "Bad"))).toEqual({ status: "fails", detail: "policy page: Schema validation error" });
  expect(judgePolicy(findPolicy(report, "Missing")).status).toBe("fails");
});

test("the results table goes between the markers and replaces an older one", () => {
  const cases = loadCases();
  const table = resultsTable([{ id: "downloads", policy: "DownloadRestrictions", status: "works", expected: "works", detail: "download never started; 0 file(s) saved" }], cases, { date: "2026-11-07", chromium: "158.0.8127.18" });
  expect(table).toContain("| DownloadRestrictions | works | download refused |");
  const doc = updateDoc("# Chrome policies\n\nIntro.\n", table);
  expect(updateDoc(doc, table.replace("2026-11-07", "2026-11-08"))).toBe(doc.replace("2026-11-07", "2026-11-08"));
});
