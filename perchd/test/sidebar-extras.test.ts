import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("no attachments, no tool; the run's extras include it when there are some", () => {
  expect(attachmentExtraTools([])).toBeUndefined();
  expect(sidebarExtras(undefined, undefined, [])).toBeUndefined();
  const extras = sidebarExtras(undefined, undefined, [{ name: "a.txt", path: join(dir, "a.txt") }])!;
  expect(extras.handles(READ_ATTACHMENT)).toBe(true);
  expect(extras.prompt()).toContain("a.txt");
});
