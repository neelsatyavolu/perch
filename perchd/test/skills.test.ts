import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AuditLog } from "../src/agent/audit";
import { runTask, type StepEvent } from "../src/agent/loop";
import type { Browser } from "../src/browser/browser";
import { combineExtraTools } from "../src/mcp-client/extra-tools";
import { fakeModel } from "../src/models/fake";
import type { Message, TurnEvent, TurnRequest } from "../src/models/types";
import { MemoryKeychain } from "../src/secure/keychain";
import { readSkillFolder } from "../src/skills/bundle";
import { builtInSkillsDir, loadBuiltInSkills, SkillCatalog } from "../src/skills/catalog";
import { findSkillImports, importSkills, previewSkills, skillsIn } from "../src/skills/import";
import { parseSkillFile } from "../src/skills/skill-file";
import { SkillStore } from "../src/skills/store";
import { skillExtraTools } from "../src/skills/tool";

const home = mkdtempSync(join(tmpdir(), "perch-skills-home-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

beforeAll(() => {
  write(join(home, ".claude", "skills", "pdf-tools", "SKILL.md"), `---
name: pdf-tools
description: >
  Fill and merge PDF forms.
  Use for any PDF task.
allowed-tools:
  - Bash
  - Read
---
# PDF tools

Read reference.md first.
`);
  write(join(home, ".claude", "skills", "pdf-tools", "reference.md"), "Use pdftk for merging.");
  write(join(home, ".claude", "skills", "pdf-tools", "scripts", "fill.py"), "print('fill')");
  write(join(home, ".claude", "skills", "pdf-tools", "node_modules", "x", "index.js"), "ignored");
  write(join(home, ".claude", "skills", "pdf-tools", ".DS_Store"), "ignored");
  symlinkSync("/etc/hosts", join(home, ".claude", "skills", "pdf-tools", "hosts-link"));
  write(join(home, ".claude", "skills", "no-frontmatter", "SKILL.md"), "# just a heading");
  write(join(home, ".codex", "skills", "Release Notes", "SKILL.md"), `---\ndescription: "Write release notes: short, plain."\n---\nSteps.`);
  write(join(home, ".codex", "skills", "pdf-tools", "SKILL.md"), `---\nname: pdf-tools\ndescription: Codex copy\n---\nOther.`);
});

test("SKILL.md frontmatter: folded and quoted descriptions, lists skipped, name from the folder when missing", () => {
  expect(parseSkillFile("---\nname: Gmail Helper\ndescription: |\n  Line one\n  Line two\nmetadata:\n  a: b\n---\nBody", "x")).toEqual({ name: "gmail-helper", description: "Line one\nLine two", body: "Body" });
  expect(parseSkillFile("---\ndescription: 'It''s here'\n---\n", "My Folder").name).toBe("my-folder");
  expect(() => parseSkillFile("no frontmatter", "x")).toThrow("must start with frontmatter");
  expect(() => parseSkillFile("---\nname: x\n---\nbody", "x")).toThrow("needs a description");
});

test("a skill folder is read without symlinks, dotfiles or node_modules", async () => {
  const b = await readSkillFolder(join(home, ".claude", "skills", "pdf-tools"));
  expect(b.name).toBe("pdf-tools");
  expect(b.description).toBe("Fill and merge PDF forms. Use for any PDF task.");
  expect(Object.keys(b.files)).toEqual(["SKILL.md", "reference.md", "scripts/fill.py"]);
});

test("the built-in site skills all parse", async () => {
  const names = (await loadBuiltInSkills()).map((s) => s.name).sort();
  expect(names).toEqual(readdirSync(join(import.meta.dir, "..", "skills")).sort());
  expect(names).toEqual(expect.arrayContaining(["github", "gmail", "google-maps"]));
});

test("import preview from Claude Code and Codex, then encrypted storage and export", async () => {
  const found = await findSkillImports({ home });
  expect(found.problems.map((p) => p.message)).toEqual(["SKILL.md must start with frontmatter (--- name and description ---)"]);
  const kc = new MemoryKeychain();
  const store = new SkillStore(join(home, "perch-skills"), kc);
  const items = previewSkills(new Set(await store.names()), found.candidates);
  expect(items.map((i) => [i.source, i.name, i.selected, i.scripts])).toEqual([
    ["Claude Code", "pdf-tools", true, ["scripts/fill.py"]],
    ["Codex", "pdf-tools", false, []],
    ["Codex", "release-notes", true, []],
  ]);
  const saved = await importSkills(store, found.candidates, items.filter((i) => i.selected).map((i) => i.id));
  expect(saved).toEqual(["pdf-tools", "release-notes"]);
  expect(await store.names()).toEqual(["pdf-tools", "release-notes"]);
  expect(readFileSync(join(store.dir, "pdf-tools.skill")).toString("latin1")).not.toContain("pdftk");
  expect(previewSkills(new Set(await store.names()), found.candidates).every((i) => !i.selected)).toBe(true);
  const out = await store.exportSkill("pdf-tools", join(home, "exported"));
  expect(readFileSync(join(out, "reference.md"), "utf8")).toBe("Use pdftk for merging.");
  await store.remove("release-notes");
  expect(await store.names()).toEqual(["pdf-tools"]);
});

test("a linked skill folder is followed; a link that leads nowhere is reported", async () => {
  const root = mkdtempSync(join(tmpdir(), "perch-skills-links-"));
  write(join(root, "shared", "linked-skill", "SKILL.md"), `---\nname: linked-skill\ndescription: Lives elsewhere.\n---\nBody.`);
  symlinkSync(join(root, "shared", "linked-skill", "SKILL.md"), join(root, "shared", "linked-skill", "inner-link"));
  mkdirSync(join(root, "skills"));
  symlinkSync(join(root, "shared", "linked-skill"), join(root, "skills", "linked-skill"));
  symlinkSync(join(root, "missing"), join(root, "skills", "broken"));
  write(join(root, "notes.txt"), "x");
  symlinkSync(join(root, "notes.txt"), join(root, "skills", "file-link"));
  const r = await skillsIn(join(root, "skills"), "Claude Code");
  expect(r.candidates.map((c) => c.bundle.name)).toEqual(["linked-skill"]);
  // Links inside a skill are still skipped.
  expect(Object.keys(r.candidates[0]!.bundle.files)).toEqual(["SKILL.md"]);
  expect(r.problems).toEqual([{ path: join(root, "skills", "broken"), message: "the link leads to nothing; it was skipped" }]);
  rmSync(root, { recursive: true, force: true });
});

const tool = (name: string, args: Record<string, unknown> = {}): TurnEvent[] => [{ type: "tool_call", call: { id: `c${Math.random()}`, name, args } }, { type: "done" }];
const say = (text: string): TurnEvent[] => [{ type: "text", delta: text }, { type: "done" }];
const lastTool = (req: TurnRequest) => [...req.messages].reverse().find((m): m is Extract<Message, { role: "tool" }> => m.role === "tool")!;

test("the agent sees skill names and descriptions, and loads a body and a file on demand", async () => {
  const kc = new MemoryKeychain();
  const store = new SkillStore(join(home, "perch-skills-2"), kc);
  await store.install(await readSkillFolder(join(home, ".claude", "skills", "pdf-tools")), "Claude Code");
  const catalog = await SkillCatalog.load({ store });
  expect(catalog.get("pdf-tools")?.origin).toBe("mine");
  expect(catalog.get("gmail")?.origin).toBe("built-in");
  const model = fakeModel([
    () => tool("load_skill", { name: "pdf-tools" }),
    (req) => (expect(lastTool(req).content).toBe("# PDF tools\n\nRead reference.md first.\n\nOther files in this skill (read one with load_skill and file): reference.md, scripts/fill.py"), tool("load_skill", { name: "pdf-tools", file: "reference.md" })),
    (req) => (expect(lastTool(req).content).toBe("Use pdftk for merging."), tool("load_skill", { name: "nope" })),
    (req) => say(lastTool(req).content),
  ]);
  const audit = new AuditLog(join(home, "audit.jsonl"));
  const events: StepEvent[] = [];
  const asked: unknown[] = [];
  for await (const e of runTask({ model, browser: {} as Browser, task: "Merge the PDFs", mode: "ask", approve: async (r) => (asked.push(r), false), audit, extraTools: combineExtraTools(skillExtraTools(catalog)) })) events.push(e);
  expect(model.requests[0]!.system).toContain("- pdf-tools: Fill and merge PDF forms. Use for any PDF task.");
  expect(model.requests[0]!.system).toContain("- gmail: Read, search, draft and send mail");
  expect(model.requests[0]!.tools.map((t) => t.name)).toContain("load_skill");
  expect(events.filter((e) => e.type === "error")).toEqual([]);
  expect(asked).toEqual([]);
  expect(events.filter((e) => e.type === "step").map((e) => (e as { label: string }).label)).toEqual(["Read the pdf-tools skill", "Read the pdf-tools skill (reference.md)"]);
  expect(events.at(-1)).toEqual({ type: "final", text: 'no skill named "nope"; use a name from the list' });
  const log = readFileSync(audit.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(log.map((l) => [l.action, l.detail, l.site])).toEqual([["load_skill", "pdf-tools", "skills"], ["load_skill", "pdf-tools/reference.md", "skills"]]);
});

test("with no skills, no tool and no prompt text are added", () => {
  const t = skillExtraTools(SkillCatalog.of([]));
  expect(t.specs()).toEqual([]);
  expect(t.prompt()).toBe("");
});

describe("builtInSkillsDir", () => {
  test("uses the source folder in development", () => {
    expect(builtInSkillsDir("/repo/perchd/src/skills", "/usr/local/bin/bun")).toBe("/repo/perchd/skills");
  });
  test("uses Resources/perch_skills next to the compiled perchd", () => {
    expect(builtInSkillsDir("/$bunfs/root", "/App/Versions/1/Helpers/perchd")).toBe("/App/Versions/1/Resources/perch_skills");
  });
});
