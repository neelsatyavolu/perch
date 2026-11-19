import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { attachmentExtraTools, READ_ATTACHMENT, sidebarExtras } from "../src/app/sidebar-extras";

const dir = mkdtempSync(join(tmpdir(), "perch-attach-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de", "hex");

test("read_attachment reads only this message's files: text as text, images as images", async () => {
  writeFileSync(join(dir, "notes.md"), "# Unit 3\nf'(x) = 2x");
  writeFileSync(join(dir, "shot.png"), png);
  writeFileSync(join(dir, "deck.key"), "binary");
  const tools = attachmentExtraTools([
    { name: "notes.md", path: join(dir, "notes.md") },
    { name: "shot.png", path: join(dir, "shot.png") },
    { name: "deck.key", path: join(dir, "deck.key") },
  ])!;
  const call = (name: string) => ({ id: "1", name: READ_ATTACHMENT, args: { name } });
  expect(tools.specs()[0]!.name).toBe(READ_ATTACHMENT);
  expect(tools.check(call("notes.md"))).toBeNull();
  expect(tools.check(call("/etc/passwd"))).toContain("must be one of the attached files");
  expect((await tools.run(call("notes.md"), new AbortController().signal)).content).toBe("# Unit 3\nf'(x) = 2x");
  const image = await tools.run(call("shot.png"), new AbortController().signal);
  expect(image.imageType).toBe("image/png");
  expect(Buffer.from(image.image!, "base64").equals(png)).toBe(true);
  expect((await tools.run(call("deck.key"), new AbortController().signal)).isError).toBe(true);
  expect(tools.describe(call("notes.md")).kind).toBe("read");
});

test("an attached folder: its name lists it, a path inside reads a file, nothing outside is reachable", async () => {
  const root = join(dir, "proj");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "README.md"), "hello");
  writeFileSync(join(root, "src", "main.ts"), "export {}");
  writeFileSync(join(dir, "secret.txt"), "no");
  symlinkSync(join(dir, "secret.txt"), join(root, "link.txt"));
  const tools = attachmentExtraTools([{ name: "proj", path: root }])!;
  const call = (name: string) => ({ id: "1", name: READ_ATTACHMENT, args: { name } });
  const signal = new AbortController().signal;
  const listing = (await tools.run(call("proj"), signal)).content;
  expect(listing).toContain("README.md");
  expect(listing).toContain("src/");
  expect((await tools.run(call("proj/src"), signal)).content).toContain("main.ts");
  expect(tools.check(call("proj/src/main.ts"))).toBeNull();
  expect((await tools.run(call("proj/src/main.ts"), signal)).content).toBe("export {}");
  expect(tools.check(call("proj/../secret.txt"))).not.toBeNull();
  expect(tools.check(call("other/x.txt"))).not.toBeNull();
  const escaped = await tools.run(call("proj/link.txt"), signal);
  expect(escaped.isError).toBe(true);
  expect(escaped.content).not.toContain("no");
  expect(tools.prompt()).toContain("proj");
});

test("an attached .zip opens like a folder, and entries that climb out of it are skipped", async () => {
  const zip = join(dir, "notes.zip");
  writeFileSync(zip, zipSync({ "notes/week1.md": strToU8("limits"), "../evil.txt": strToU8("x"), "top.txt": strToU8("hi") }));
  const tools = attachmentExtraTools([{ name: "notes.zip", path: zip }])!;
  const call = (name: string) => ({ id: "1", name: READ_ATTACHMENT, args: { name } });
  const signal = new AbortController().signal;
  const listing = (await tools.run(call("notes.zip"), signal)).content;
  expect(listing).toContain("notes/");
  expect(listing).toContain("top.txt");
  expect(listing).not.toContain("evil");
  expect((await tools.run(call("notes.zip/notes/week1.md"), signal)).content).toBe("limits");
});

test("no attachments, no tool; the run's extras include it when there are some", () => {
  expect(attachmentExtraTools([])).toBeUndefined();
  expect(sidebarExtras(undefined, undefined, [])).toBeUndefined();
  const extras = sidebarExtras(undefined, undefined, [{ name: "a.txt", path: join(dir, "a.txt") }])!;
  expect(extras.handles(READ_ATTACHMENT)).toBe(true);
  expect(extras.prompt()).toContain("a.txt");
});
