import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/agent/audit";
import { classify, needsApproval, type Decision, type Kind, type Mode } from "../src/agent/permissions";

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "c1", name, args });

test.each([
  [call("navigate", { url: "https://x.com" }), undefined, "read"],
  [call("snapshot"), undefined, "read"],
  [call("scroll", { dy: 400 }), undefined, "read"],
  [call("click", { ref: "e1" }), { role: "button", name: "Next" }, "change"],
  [call("click", { ref: "e1" }), { role: "button", name: "Send message" }, "risky"],
  [call("click", { ref: "e1" }), { role: "button", name: "Post" }, "risky"],
  [call("click", { ref: "e1" }), { role: "button", name: "Delete 3 emails" }, "risky"],
  [call("click", { ref: "e1" }), { role: "button", name: "Pay $42.18" }, "payment"],
  [call("click", { ref: "e1" }), { role: "button", name: "Place order" }, "payment"],
  [call("click", { ref: "e1" }), { role: "button", name: "Continue (€19.99)" }, "payment"],
  [call("click", { ref: "e1" }), { role: "button", name: "Change password" }, "payment"],
  [call("type", { ref: "e2", text: "hi" }), { role: "textbox", name: "Message" }, "change"],
  [call("select", { ref: "e3", value: "Canada" }), { role: "combobox", name: "Country" }, "change"],
  [call("upload", { ref: "e4", paths: ["/tmp/a"] }), { role: "button", name: "Attach" }, "risky"],
  [call("drag", { ref: "e5", dx: 40 }), { role: "slider", name: "Max price" }, "change"],
  [call("drag", { ref: "e5", to: "e6" }), { role: "button", name: "Delete card" }, "risky"],
  [call("press", { key: "Enter" }), { role: "searchbox", name: "Search mail" }, "change"],
  [call("press", { key: "Enter" }), { role: "textbox", name: "Message" }, "risky"],
  [call("press", { key: "ArrowDown" }), { role: "textbox", name: "Message" }, "change"],
  [call("click_at", { x: 10, y: 10 }), undefined, "risky"],
  [call("repl", { code: "return document.title" }), undefined, "read"],
  [call("repl", { code: "document.querySelector('#send').click()" }), undefined, "read"],
  [call("mystery_tool"), undefined, "risky"],
  [call("click", { ref: "e1" }), { role: "button", name: "Place your order" }, "payment"],
  [call("click", { ref: "e1" }), { role: "button", name: "Complete booking" }, "payment"],
  [call("click", { ref: "e1" }), { role: "button", name: "Reserve" }, "payment"],
  [call("click", { ref: "e1" }), { role: "button", name: "Request to book" }, "payment"],
  [call("click", { ref: "e1" }), { role: "button", name: "Submit order" }, "payment"],
  [call("click", { ref: "e1" }), { role: "link", name: "Facebook" }, "change"],
  [call("click", { ref: "e1" }), { role: "button", name: "Under $25,000" }, "change"],
  [call("click", { ref: "e1" }), { role: "link", name: "Middle Income Jobs ($30K-$49K)" }, "change"],
  [call("click", { ref: "e1" }), { role: "checkbox", name: "My device will have a $0 trade-in value unless I reset it. I agree to Terms" }, "change"],
  [call("click", { ref: "e1" }), { role: "button", name: "$9.99" }, "payment"],
  [call("click", { ref: "e1" }), { role: "button", name: "Get it for US$4.99" }, "payment"],
  [call("click", { ref: "e1" }), undefined, "risky"],
  [call("type", { ref: "e2", text: "Running late", submit: true }), { role: "textbox", name: "Message" }, "risky"],
  [call("type", { ref: "e2", text: "perch", submit: true }), { role: "searchbox", name: "Search mail" }, "change"],
] as const)("classify %o on %o is %s", (c, target, kind) => {
  expect(classify(c, target)).toBe(kind as Kind);
});

test("a drag is judged by its source and by what it is dropped on", () => {
  const card = { role: "button", name: "Card one" };
  expect(classify(call("drag", { ref: "e5", to: "e6" }), card, {}, { role: "region", name: "Done column" })).toBe("change");
  expect(classify(call("drag", { ref: "e5", to: "e6" }), card, {}, { role: "button", name: "Delete" })).toBe("risky");
  expect(classify(call("drag", { ref: "e5", to: "e6" }), card, {}, undefined)).toBe("risky");
  expect(classify(call("drag", { ref: "e5", to: "e6" }), card, {}, { role: "button", name: "Buy now" })).toBe("payment");
  // A drag by zero pixels is a click, so the source gets the click rules.
  expect(classify(call("drag", { ref: "e5", dx: 0, dy: 0 }), { role: "button", name: "Buy now" })).toBe("payment");
  expect(classify(call("drag", { ref: "e5", dx: 0 }), undefined)).toBe("risky");
});

test("a drag by pixels lands on an element nobody identified, so it asks unless it moves a slider", () => {
  // A message dragged by an offset onto a Trash or Delete zone must not run unasked in Guard mode.
  const message = { role: "row", name: "Invoice from Acme" };
  expect(classify(call("drag", { ref: "e5", dx: -600, dy: 120 }), message)).toBe("risky");
  expect(needsApproval("guard", classify(call("drag", { ref: "e5", dx: -600, dy: 120 }), message))).toBe("ask");
  expect(classify(call("drag", { ref: "e5", dy: 80 }), { role: "button", name: "Buy now" })).toBe("payment");
  // Sliders, scrollbars and splitters move along a track: there is nothing to drop onto.
  expect(classify(call("drag", { ref: "e5", dx: 40 }), { role: "slider", name: "Max price" })).toBe("change");
  expect(classify(call("drag", { ref: "e5", dy: 200 }), { role: "scrollbar", name: "" })).toBe("change");
  expect(classify(call("drag", { ref: "e5", dx: -80 }), { role: "separator", name: "Resize panel" })).toBe("change");
});

test.each([
  [call("click", { ref: "e1" }), { role: "button", name: "Continue" }, { payment: true }, "payment"],
  [call("click", { ref: "e1" }), { role: "button", name: "Next" }, { payment: true }, "payment"],
  [call("click", { ref: "e1" }), { role: "link", name: "Shipping policy" }, { payment: true }, "change"],
  [call("click_at", { x: 1, y: 1 }), undefined, { payment: true }, "payment"],
  [call("press", { key: "Enter" }), { role: "iframe", name: "" }, { payment: true }, "payment"],
  [call("type", { ref: "e3", text: "123", submit: true }), { role: "textbox", name: "Security code" }, { payment: true }, "payment"],
  [call("click", { ref: "e1" }), { role: "button", name: "Save" }, { passwordChange: true }, "payment"],
  [call("click", { ref: "e1" }), { role: "button", name: "Update" }, { passwordChange: true }, "payment"],
  [call("click", { ref: "e1" }), { role: "button", name: "Save" }, {}, "change"],
  [call("click", { ref: "e1" }), { role: "button", name: "Under $25,000" }, { payment: true }, "payment"],
] as const)("in page context, classify %o on %o with %o is %s", (c, target, page, kind) => {
  expect(classify(c, target, page)).toBe(kind as Kind);
});

const MODES: Mode[] = ["ask", "guard", "skip"];
const KINDS: Kind[] = ["read", "change", "risky", "payment"];
const EXPECTED: Record<Mode, Record<Kind, Decision>> = {
  ask: { read: "run", change: "ask", risky: "ask", payment: "ask" },
  guard: { read: "run", change: "run", risky: "ask", payment: "ask" },
  skip: { read: "run", change: "run", risky: "run", payment: "ask" },
};

for (const mode of MODES) {
  for (const kind of KINDS) {
    test(`${mode} mode, ${kind}: ${EXPECTED[mode][kind]}`, () => {
      expect(needsApproval(mode, kind)).toBe(EXPECTED[mode][kind]);
    });
  }
}

test.each([
  ["never", "read", "run"], ["never", "change", "block"], ["never", "payment", "block"],
  ["ask", "read", "run"], ["ask", "change", "ask"], ["ask", "risky", "ask"],
  ["allow", "change", "run"], ["allow", "risky", "run"], ["allow", "payment", "ask"],
] as const)("site rule %s with %s: %s (any mode)", (rule, kind, want) => {
  for (const mode of MODES) expect(needsApproval(mode, kind, rule)).toBe(want);
});

test("the audit log appends JSON lines a fresh reader can parse, readable only by the owner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perch-audit-"));
  const path = join(dir, "nested", "audit.jsonl");
  const log = new AuditLog(path);
  await log.append({ time: "2026-11-05T01:00:00Z", tab: "t1", site: "mailroom.app", action: "click", detail: 'button "Send"', client: "sidebar", approved: true, result: "ok" });
  await log.append({ time: "2026-11-05T01:00:01Z", tab: "t1", site: "mailroom.app", action: "type", detail: "14 characters", client: "mcp:claude-code", approved: null, result: "ok" });
  const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(lines).toHaveLength(2);
  expect(lines[1]).toMatchObject({ action: "type", client: "mcp:claude-code", approved: null });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  rmSync(dir, { recursive: true, force: true });
});
