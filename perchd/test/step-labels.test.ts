import { expect, test } from "bun:test";
import { stepLabel } from "../src/app/sidebar-runner";
import { label } from "../src/agent/session";
import { TOOL_SPECS } from "../src/agent/tools";

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "c1", name, args });

/** Arguments every tool accepts the shape of, so each label can be built. */
const ARGS = { url: "https://example.com/", path: "/tmp/a.txt", key: "Enter", value: "v", paths: ["/tmp/a.txt"], name: "notes.txt", text: "hi" };

test("no step shows a raw tool name", () => {
  for (const { name } of TOOL_SPECS) {
    expect(label(call(name, ARGS), undefined, "example.com")).not.toMatch(/_/);
    expect(stepLabel(name, ARGS)).not.toMatch(/_/);
  }
});

test("document and file steps say what they read or made", () => {
  expect(label(call("read_document", { url: "https://bu.edu/files/Admissions%20Guide.pdf" }), undefined, "bu.edu")).toBe("Read Admissions Guide.pdf");
  expect(label(call("read_document", { url: "https://docs.example.com/" }), undefined, "x")).toBe("Read a document on docs.example.com");
  expect(label(call("write_file", { name: "listings.csv", content: "a,b" }), undefined, "x")).toBe("Saved listings.csv");
  expect(label(call("make_zip", { name: "applications" }), undefined, "x")).toBe("Made applications.zip");
  expect(label(call("make_zip", { name: "applications.zip" }), undefined, "x")).toBe("Made applications.zip");
  expect(label(call("find", { role: "button", name: "Submit", contains: true }), undefined, "x")).toBe('Looked for button "Submit"');
  expect(label(call("find", {}), undefined, "x")).toBe("Looked through the page");
});

test("a tool with no wording of its own reads as words", () => {
  expect(label(call("some_new_tool"), undefined, "x")).toBe("Some new tool");
  expect(stepLabel("mcp__github__create_issue", {})).toBe("Create issue");
});
