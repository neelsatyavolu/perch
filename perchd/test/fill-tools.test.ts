import { expect, test } from "bun:test";
import type { AuditEntry, AuditLog } from "../src/agent/audit";
import { maskUsername, memoryFillSites } from "../src/agent/fill-tools";
import type { Mode } from "../src/agent/permissions";
import { callTool, label, type ApprovalRequest } from "../src/agent/session";
import { TOOL_SPECS } from "../src/agent/tool-specs";
import type { ToolContext } from "../src/agent/tools";
import { describeApproval } from "../src/app/approval-card";
import { rememberedSecrets, secretKey } from "../src/page/secrets";

const USERNAME = "neel.satya@example.com";
const LAST_FOUR = "4242";

type Sent = { method: string; params: Record<string, unknown> };

function fakeConn(opts: { logins?: boolean; cards?: boolean; fill?: string; code?: string } = {}) {
  const sent: Sent[] = [];
  const reply: Record<string, (p: Record<string, unknown>) => unknown> = {
    "Perch.listLogins": () => ({ logins: opts.logins === false ? [] : [{ loginId: "L1", username: USERNAME, origin: "https://github.com" }] }),
    "Perch.fillLogin": () => ({ result: opts.fill ?? "filled", fields: [41, 42] }),
    "Perch.listCards": () => ({ cards: opts.cards === false ? [] : [{ cardId: "C1", network: "Visa", lastFour: LAST_FOUR, expiry: "12/30" }] }),
    "Perch.fillCard": () => ({ result: opts.fill ?? "filled", fields: [77] }),
    "Perch.getExtensionTabId": () => ({ tabId: 7 }),
    "Target.getTargets": () => ({ targetInfos: [{ targetId: "SW", type: "service_worker", url: "chrome-extension://ocjanjehckpdbcjamffmbeemoooamjpo/background/index.js" }] }),
    "Target.attachToTarget": () => ({ sessionId: "S1" }),
    "Runtime.evaluate": () => ({ result: { objectId: "G" } }),
    "Runtime.callFunctionOn": () => ({ result: { value: opts.code ?? "filled" } }),
    "Target.detachFromTarget": () => ({}),
  };
  return {
    sent,
    conn: {
      send: async (method: string, params: Record<string, unknown> = {}) => {
        sent.push({ method, params });
        const r = reply[method];
        if (!r) throw new Error(`unexpected ${method}`);
        return r(params);
      },
    },
  };
}

function context(conn: unknown, perch = true): ToolContext {
  const tab = { id: "T1", url: async () => "https://github.com/login", evaluate: async () => null };
  return {
    browser: { perch, conn } as never,
    tab: tab as never,
    owned: [],
    borrowedTabs: [],
    lastSnapshot: new WeakMap(),
    shotScale: 1,
    workDir: "/tmp",
    fillSites: memoryFillSites(),
    close: async () => {},
  };
}

function policy(mode: Mode, approvals: ApprovalRequest[], answer = true) {
  const entries: AuditEntry[] = [];
  return {
    entries,
    opts: {
      mode,
      approve: async (r: ApprovalRequest) => (approvals.push(r), answer),
      audit: { append: async (e: AuditEntry) => void entries.push(e) } as unknown as AuditLog,
    },
  };
}

const call = (name: string) => ({ id: "c1", name, args: {} });

test("the fill tools are offered to the model with no arguments", () => {
  for (const name of ["sign_in", "fill_card", "fill_code"]) {
    const s = TOOL_SPECS.find((t) => t.name === name);
    expect(s).toBeDefined();
    expect(Object.keys((s!.parameters as { properties: object }).properties)).toEqual([]);
  }
});

test("sign_in in Guard asks the first time on a site and not the second", async () => {
  const { conn, sent } = fakeConn();
  const ctx = context(conn);
  const approvals: ApprovalRequest[] = [];
  const p = policy("guard", approvals);
  const first = await callTool(ctx, p.opts, call("sign_in"));
  expect(first).toEqual({ content: "filled" });
  expect(approvals.length).toBe(1);
  expect(approvals[0]!.summary).toBe("Sign in to github.com as neel.satya@…");
  expect(sent.find((s) => s.method === "Perch.fillLogin")?.params).toEqual({ targetId: "T1", loginId: "L1" });
  const second = await callTool(ctx, p.opts, call("sign_in"));
  expect(second).toEqual({ content: "filled" });
  expect(approvals.length).toBe(1);
});

test("a declined sign-in fills nothing and is still asked next time", async () => {
  const { conn, sent } = fakeConn();
  const ctx = context(conn);
  const approvals: ApprovalRequest[] = [];
  await callTool(ctx, policy("guard", approvals, false).opts, call("sign_in"));
  expect(sent.some((s) => s.method === "Perch.fillLogin")).toBe(false);
  await callTool(ctx, policy("guard", approvals).opts, call("sign_in"));
  expect(approvals.length).toBe(2);
});

test("fill_card asks even in skip mode, and its card names the card for the user", async () => {
  const { conn } = fakeConn();
  const ctx = context(conn);
  const approvals: ApprovalRequest[] = [];
  const p = policy("skip", approvals);
  expect(await callTool(ctx, p.opts, call("fill_card"))).toEqual({ content: "filled" });
  expect(await callTool(ctx, p.opts, call("fill_card"))).toEqual({ content: "filled" });
  expect(approvals.length).toBe(2);
  expect(approvals[0]!.kind).toBe("payment");
  const card = describeApproval(approvals[0]!, { id: "a", chatId: "c", runId: "r" });
  expect(card.title).toBe("Fill Visa ending 4242 on github.com");
  expect(card.confirm).toBe("Fill card");
  expect(card.danger).toBe(true);
});

test("the model sees only fixed words, and the transcript never holds the username or card digits", async () => {
  const transcript: string[] = [];
  const record = (name: string, content: string) => transcript.push(JSON.stringify({ call: call(name), result: content, step: label(call(name), undefined, "github.com") }));
  for (const [opts, name, expected] of [
    [{}, "sign_in", "filled"],
    [{ logins: false }, "sign_in", "no saved login"],
    [{ fill: "needs-user" }, "sign_in", "needs you"],
    [{}, "fill_card", "filled"],
    [{ cards: false }, "fill_card", "no saved card"],
    [{}, "fill_code", "filled"],
    [{ code: "no-code" }, "fill_code", "no saved code"],
    [{ code: "no-field" }, "fill_code", "needs you"],
  ] as const) {
    const { conn } = fakeConn(opts);
    const p = policy("ask", []);
    const r = await callTool(context(conn), p.opts, call(name));
    expect(r.content).toBe(expected);
    record(name, String(r.content));
    for (const e of p.entries) transcript.push(JSON.stringify(e));
  }
  const all = transcript.join("\n");
  expect(all).not.toContain("neel.satya");
  expect(all).not.toContain(LAST_FOUR);
});

test("the filled fields join the tab's secret set, so snapshots hide them", async () => {
  const { conn } = fakeConn();
  const ctx = context(conn);
  await callTool(ctx, policy("ask", []).opts, call("sign_in"));
  const secrets = rememberedSecrets(ctx.tab!);
  expect(secrets.has(secretKey(41))).toBe(true);
  expect(secrets.has(secretKey(42))).toBe(true);
});

test("a code fill goes to the Perch extension's service worker with the tab's extension id", async () => {
  const { conn, sent } = fakeConn();
  await callTool(context(conn), policy("ask", []).opts, call("fill_code"));
  const fn = sent.find((s) => s.method === "Runtime.callFunctionOn")!.params;
  expect(fn.arguments).toEqual([{ value: 7 }, { value: "https://github.com/login" }]);
  expect(fn.returnByValue).toBe(true);
  expect(sent.some((s) => s.method === "Target.detachFromTarget")).toBe(true);
});

test("outside Perch the fill tools explain that they need Perch", async () => {
  const { conn, sent } = fakeConn();
  const r = await callTool(context(conn, false), policy("skip", []).opts, call("sign_in"));
  expect(r.isError).toBe(true);
  expect(String(r.content)).toContain("inside Perch");
  expect(sent).toEqual([]);
});

test("usernames are masked on the card", () => {
  expect(maskUsername("neel@example.com")).toBe("neel@…");
  expect(maskUsername("neelsat")).toBe("ne…");
  expect(maskUsername("ab")).toBe("…");
});
