import { expect, test } from "bun:test";
import { isLocalUrl } from "../src/agent/tools";

test("pages on the user's own machine open as ordinary tabs, everything else as agent tabs", () => {
  for (const url of ["http://localhost:5173/", "http://127.0.0.1:8080/x", "http://[::1]:3000/", "http://app.localhost/", "http://0.0.0.0:4000", "file:///Users/me/report.html"]) {
    expect(isLocalUrl(url)).toBe(true);
  }
  for (const url of ["https://example.com", "https://localhost.example.com", "http://10.0.0.5/", "about:blank", "not a url"]) {
    expect(isLocalUrl(url)).toBe(false);
  }
});
