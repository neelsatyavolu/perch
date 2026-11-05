import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/preact";
import { PageFrame, RELEASES_URL } from "../../src/ui/frame";

afterEach(cleanup);

describe("PageFrame without perchd", () => {
  test("points to the project's GitHub releases, not an unregistered domain", () => {
    const r = render(<PageFrame api={null}><p>page</p></PageFrame>);
    expect(r.getByRole("heading", { name: "Perch's background service isn't running" })).toBeTruthy();
    const text = r.getByRole("main").textContent ?? "";
    expect(text).toContain(RELEASES_URL);
    expect(RELEASES_URL.startsWith("https://github.com/")).toBe(true);
    expect(text).not.toContain("perchbrowser.com");
  });
});
