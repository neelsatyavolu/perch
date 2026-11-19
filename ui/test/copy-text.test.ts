import { afterEach, expect, test } from "bun:test";
import { copyText } from "../src/components/copy-text";
import { startShell } from "../src/host/shell";

const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  if (realClipboard) Object.defineProperty(navigator, "clipboard", realClipboard);
  document.body.innerHTML = "";
});

test("the shell lets its chat frame write the clipboard, so Copy buttons work", () => {
  startShell(window as never, "chat.html");
  expect(document.querySelector("iframe")!.allow).toContain("clipboard-write");
});

test("copyText falls back to execCommand when the Clipboard API is refused, and throws when nothing copied", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("NotAllowedError")) } });
  const copied: string[] = [];
  (document as unknown as { execCommand: (c: string) => boolean }).execCommand = (c) => {
    copied.push(`${c}:${(document.activeElement as HTMLTextAreaElement | null)?.value ?? (document.querySelector("textarea")?.value ?? "")}`);
    return true;
  };
  await copyText("hello");
  expect(copied).toEqual(["copy:hello"]);
  expect(document.querySelector("textarea")).toBeNull();
  (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
  await expect(copyText("x")).rejects.toThrow();
});
