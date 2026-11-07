/**
 * Checks Chrome policies against a dev build of Perch (plan 8, task 3), without touching the
 * machine: each case gets a throwaway profile whose Local State carries the policies as Chromium's
 * local test policies (`local_test_policies_for_next_startup`), which a dev build loads at start
 * as mandatory machine policies. Perch then runs headless over a CDP pipe and the case looks for
 * the policy's effect: a blocked navigation, a refused download, a request through the proxy, or
 * the policy page's own status.
 *
 *   bun run scripts/policy-check.ts --app <dev Perch.app> [--cases <json>] [--doc <md>]
 *
 * A release build is refused: it must not load test policies at all (plan 8, task 2).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { launchChromium } from "../src/cdp/pipe";
import type { CdpConnection } from "../src/cdp/connection";

export type TestPolicy = { name: string; value: unknown };
export type Check =
  | { kind: "navigation"; blocked: string; allowed: string }
  | { kind: "download"; path: string }
  | { kind: "proxy"; url: string }
  | { kind: "policy"; names?: string[] };
/**
 * "mdm-only": Chromium never takes this policy from test policies (FilterSensitivePolicies in
 * components/policy/core/common/policy_loader_common.cc blocks it), so only a managed Mac can show
 * it working; the check passes when the page reports it blocked, and the owner's MDM check covers it.
 */
export type Expectation = "works" | "ignored" | "mdm-only";
export type Case = { id: string; policies: TestPolicy[]; check: Check; expect: Expectation; note?: string };
export type CaseResult = { policy: string; status: "works" | "ignored" | "fails"; detail: string };
export type Outcome = CaseResult & { id: string; expected: Expectation };

/** The policy page's text for a policy Chromium blocked. */
export const BLOCKED_TEXT = "This policy is blocked";

/** Whether a case came out as expected. */
export const asExpected = (r: Outcome): boolean => r.status === r.expected || (r.expected === "mdm-only" && r.detail.includes(BLOCKED_TEXT));

/** PolicyLevel, PolicyScope and PolicySource in components/policy/core/common/policy_types.h on 158. */
export const MANDATORY = 1;
export const MACHINE = 1;
export const PLATFORM = 5;
export const LOCAL_TEST_POLICIES = "local_test_policies_for_next_startup";
/**
 * What chrome://policy says about a Google-only policy Perch blocks (FilterGoogleOnlyPolicies,
 * patches/perch/policy/ignored-google-policies.patch). It reuses Chromium's own "blocked" string,
 * so no translated string changes.
 */
export const IGNORED_TEXT = "This policy is blocked, its value will be ignored.";
/** The Google-only policies Perch blocks (components/policy/core/common/policy_loader_common.cc). */
export const GOOGLE_ONLY: ReadonlySet<string> = new Set(["BrowserSignin", "CloudManagementEnrollmentToken", "MetricsReportingEnabled"]);

const REPO = join(import.meta.dir, "..", "..");
const SETTLE_MS = 3000;

/** Writes `Local State` so the next start loads these policies as mandatory machine policies. */
export async function writeLocalState(dir: string, policies: readonly TestPolicy[]): Promise<void> {
  const list = policies.map((p) => ({ level: MANDATORY, scope: MACHINE, source: PLATFORM, name: p.name, value: p.value }));
  await Bun.write(join(dir, "Local State"), JSON.stringify({ [LOCAL_TEST_POLICIES]: JSON.stringify(list) }));
}

export type BuildProbe = { argsGn: (path: string) => string | null; codesign: (app: string) => string };

const realProbe: BuildProbe = {
  argsGn: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
  codesign: (app) => spawnSync("codesign", ["-dv", app], { encoding: "utf8" }).stderr ?? "",
};

/** "official" for a release build: its out folder says is_official_build, or it is Developer ID signed. */
export function buildKind(app: string, probe: BuildProbe = realProbe): "official" | "dev" {
  const args = probe.argsGn(join(dirname(app), "args.gn"));
  if (args !== null) return /^\s*is_official_build\s*=\s*true/m.test(args) ? "official" : "dev";
  return /Authority=Developer ID Application/.test(probe.codesign(app)) ? "official" : "dev";
}

export function requireDevBuild(app: string, probe?: BuildProbe): void {
  if (buildKind(app, probe) === "official") throw new Error(`${app} is a release build, which must not load test policies. Use a dev build.`);
}

export function loadCases(file = join(REPO, "enterprise", "chrome-policy-check.json")): Case[] {
  return (JSON.parse(readFileSync(file, "utf8")) as { cases: Case[] }).cases;
}

/** Puts the local server and proxy addresses into a case's values. */
export function fill(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") return value.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

/** The policy page's entry for a policy, from its own JSON export. */
export function findPolicy(report: unknown, name: string): Record<string, unknown> | null {
  if (!report || typeof report !== "object") return null;
  const r = report as Record<string, unknown>;
  const policies = r.policies as Record<string, unknown> | undefined;
  if (policies && typeof policies === "object" && name in policies) return policies[name] as Record<string, unknown>;
  for (const v of Object.values(r)) {
    const found = findPolicy(v, name);
    if (found) return found;
  }
  return null;
}

/** How the policy page reports one policy: applied, ignored by Perch, or a problem. */
export function judgePolicy(entry: Record<string, unknown> | null, name = ""): Pick<CaseResult, "status" | "detail"> {
  if (!entry) return { status: "fails", detail: "not listed on the policy page" };
  const error = typeof entry.error === "string" ? entry.error : "";
  // Chromium uses the same words for its own sensitive policies; only Perch's list is "ignored".
  if (error.includes(IGNORED_TEXT) && GOOGLE_ONLY.has(name)) return { status: "ignored", detail: "policy page: ignored in Perch" };
  if (error) return { status: "fails", detail: `policy page: ${error}` };
  if (entry.ignored === true) return { status: "fails", detail: "policy page: ignored" };
  return { status: "works", detail: "policy page: applied" };
}

async function newPage(conn: CdpConnection): Promise<string> {
  const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  await conn.send("Page.enable", {}, sessionId);
  return sessionId;
}

const navigate = (conn: CdpConnection, session: string, url: string) => conn.send<{ errorText?: string }>("Page.navigate", { url }, session);

async function policyReport(conn: CdpConnection, session: string): Promise<unknown> {
  await navigate(conn, session, "chrome://policy");
  await Bun.sleep(1000);
  const expression = "(async () => (await import('chrome://resources/js/cr.js')).sendWithPromise('getPoliciesJson', 0))()";
  const { result } = await conn.send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
  return typeof result.value === "string" ? JSON.parse(result.value) : result.value;
}

type Env = { conn: CdpConnection; session: string; origin: string; proxied: string[]; downloads: string; control: () => Promise<number> };

async function downloadOnce(conn: CdpConnection, session: string, url: string, dir: string): Promise<number> {
  await navigate(conn, session, url);
  await Bun.sleep(SETTLE_MS);
  return readdirSync(dir).filter((f) => !f.endsWith(".crdownload")).length;
}

async function runCheck(c: Case, env: Env): Promise<Pick<CaseResult, "status" | "detail">> {
  const { conn, session } = env;
  switch (c.check.kind) {
    case "navigation": {
      const blocked = await navigate(conn, session, `${env.origin}${c.check.blocked}`);
      const allowed = await navigate(conn, session, `${env.origin}${c.check.allowed}`);
      const ok = blocked.errorText === "net::ERR_BLOCKED_BY_ADMINISTRATOR" && !allowed.errorText;
      return { status: ok ? "works" : "fails", detail: `blocked page: ${blocked.errorText ?? "loaded"}; allowed page: ${allowed.errorText ?? "loaded"}` };
    }
    case "download": {
      // DevTools' own download handling would step around the policy, so the browser saves to
      // DownloadDirectory as it would for a person; a control run without the restriction must save.
      const saved = await downloadOnce(conn, session, `${env.origin}${c.check.path}`, env.downloads);
      const control = await env.control();
      if (control === 0) return { status: "fails", detail: "the control run without the restriction saved nothing either, so this proves nothing" };
      return { status: saved === 0 ? "works" : "fails", detail: `${saved} file(s) saved with the policy, ${control} without it` };
    }
    case "proxy": {
      await navigate(conn, session, c.check.url);
      await Bun.sleep(500);
      const host = new URL(c.check.url).hostname;
      const seen = env.proxied.some((h) => h.split(":")[0] === host);
      return { status: seen ? "works" : "fails", detail: seen ? `the check's proxy received the request for ${host}` : "the request did not reach the check's proxy" };
    }
    case "policy": {
      const report = await policyReport(conn, session);
      const names = c.check.names ?? c.policies.map((p) => p.name);
      const judged = names.map((n) => ({ n, ...judgePolicy(findPolicy(report, n), n) }));
      const worst = judged.find((j) => j.status === "fails") ?? judged.find((j) => j.status === "ignored") ?? judged[0]!;
      return { status: worst.status, detail: judged.map((j) => `${j.n}: ${j.detail.replace("policy page: ", "")}`).join("; ") };
    }
  }
}

function startServers() {
  const proxied: string[] = [];
  const site = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/download") return new Response("perch", { headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="check.bin"' } });
      return new Response(`<title>${path}</title>${path}`, { headers: { "content-type": "text/html" } });
    },
  });
  const proxy = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      // Perch upgrades to https first, so the proxy may see a CONNECT; the Host header names the site either way.
      proxied.push(req.headers.get("host") ?? "");
      return new Response("proxied", { headers: { "content-type": "text/plain" } });
    },
  });
  return { site, proxy, proxied, stop: () => (site.stop(true), proxy.stop(true)) };
}

/** Starts the dev build headless in a throwaway profile carrying `policies`, runs `fn`, and cleans up. */
async function withBrowser<T>(executable: string, policies: readonly TestPolicy[], fn: (conn: CdpConnection, session: string) => Promise<T>, dir = mkdtempSync(join(tmpdir(), "perch-policy-check-"))): Promise<T> {
  await writeLocalState(dir, policies);
  const conn = await launchChromium({ executable, userDataDir: dir, headless: true });
  try {
    return await fn(conn, await newPage(conn));
  } finally {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function policyCheck(opts: { app: string; cases: readonly Case[] }): Promise<Outcome[]> {
  requireDevBuild(opts.app);
  const executable = join(opts.app, "Contents", "MacOS", "Perch");
  const servers = startServers();
  const vars = { server: `http://127.0.0.1:${servers.site.port}`, proxy: `127.0.0.1:${servers.proxy.port}` };
  const results: Outcome[] = [];
  try {
    for (const c of opts.cases) {
      const downloads = mkdtempSync(join(tmpdir(), "perch-policy-downloads-"));
      const where = { name: "DownloadDirectory", value: downloads };
      const policies = [...c.policies.map((p) => ({ name: p.name, value: fill(p.value, vars) })), ...(c.check.kind === "download" ? [where] : [])];
      const control = async () => {
        const dir = mkdtempSync(join(tmpdir(), "perch-policy-control-"));
        rmSync(downloads, { recursive: true, force: true });
        mkdirSync(downloads);
        return withBrowser(executable, [where], (conn, session) => downloadOnce(conn, session, `${vars.server}${(c.check as { path: string }).path}`, downloads), dir);
      };
      const r = await withBrowser(executable, policies, (conn, session) => runCheck(c, { conn, session, origin: vars.server, proxied: servers.proxied, downloads, control }))
        .catch((e: Error) => ({ status: "fails" as const, detail: e.message }));
      results.push({ id: c.id, policy: c.policies.map((p) => p.name).join(", "), expected: c.expect, ...r });
      rmSync(downloads, { recursive: true, force: true });
    }
  } finally {
    servers.stop();
  }
  return results;
}

const BEGIN = "<!-- policy-check:begin -->";
const END = "<!-- policy-check:end -->";

/** The results table, put between the markers in docs/enterprise/chrome-policies.md. */
export function resultsTable(results: readonly Outcome[], cases: readonly Case[], meta: { date: string; chromium: string }): string {
  const how = (c: Case | undefined) =>
    !c ? "" : c.check.kind === "navigation" ? "navigation blocked except the allowed path" : c.check.kind === "download" ? "download refused" : c.check.kind === "proxy" ? "request seen by a local proxy" : "status on the policy page";
  const rows = results.map((r) => {
    const c = cases.find((x) => x.id === r.id);
    const status = r.expected === "mdm-only" && asExpected(r) ? "blocked in test policies; needs a managed Mac" : asExpected(r) ? r.status : `${r.status} (expected ${r.expected})`;
    return `| ${r.policy} | ${status} | ${how(c)} | ${r.detail.replace(/\|/g, "\\|")} |`;
  });
  return [BEGIN, `Checked ${meta.date} on Chromium ${meta.chromium}.`, "", "| Policy | Result | How it was checked | Detail |", "|---|---|---|---|", ...rows, END].join("\n");
}

export function updateDoc(doc: string, table: string): string {
  const start = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (start === -1 || end === -1) return `${doc.trimEnd()}\n\n${table}\n`;
  return `${doc.slice(0, start)}${table}${doc.slice(end + END.length)}`;
}

async function main(argv: string[]): Promise<number> {
  const arg = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const app = arg("--app");
  if (!app) {
    process.stderr.write("Give the dev build: bun run scripts/policy-check.ts --app <out/Dev/Perch.app>\n");
    return 64;
  }
  const cases = loadCases(arg("--cases"));
  const results = await policyCheck({ app, cases });
  for (const r of results) process.stdout.write(`${asExpected(r) ? "ok  " : "FAIL"} ${r.policy}: ${r.status} (${r.detail})\n`);
  const docPath = arg("--doc") ?? join(REPO, "docs", "enterprise", "chrome-policies.md");
  const chromium = (JSON.parse(readFileSync(join(REPO, "version.json"), "utf8")) as { chromium?: string }).chromium ?? "unknown";
  const table = resultsTable(results, cases, { date: new Date().toISOString().slice(0, 10), chromium });
  writeFileSync(docPath, updateDoc(existsSync(docPath) ? readFileSync(docPath, "utf8") : "", table));
  return results.every(asExpected) ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
