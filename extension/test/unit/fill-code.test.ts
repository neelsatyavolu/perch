import { describe, expect, test } from "bun:test";
import { fillCodeInFrame, type FillDeps, type Frame } from "../../src/totp/fill-code";
import type { VaultEntry } from "../../src/totp/vault";

const CODE = "482915";
const entry = (site: string | null, account = "alice"): VaultEntry => ({
  id: crypto.randomUUID(),
  issuer: "Example",
  account,
  secret: "JBSWY3DPEHPK3PXP",
  algorithm: "SHA1",
  digits: 6,
  period: 30,
  site,
  added: 0,
});

type Fill = { tabId: number; frame: Frame; code: string; host: string };

function deps(opts: { entries?: readonly VaultEntry[] | null; frames?: readonly Frame[]; field?: boolean } = {}) {
  const fills: Fill[] = [];
  const coded: VaultEntry[] = [];
  const d: FillDeps = {
    entries: async () => (opts.entries === undefined ? [entry("example.com")] : opts.entries),
    frames: async () => opts.frames ?? [{ frameId: 0, documentId: "doc-main", url: "https://login.example.com/2fa" }],
    code: async (e) => (coded.push(e), CODE),
    fill: async (tabId, frame, code, host) => (fills.push({ tabId, frame, code, host }), opts.field ?? true),
  };
  return { d, fills, coded };
}

describe("fillCodeInFrame", () => {
  test("fills the matching account's code into the frame and answers only 'filled'", async () => {
    const { d, fills } = deps();
    const result = await fillCodeInFrame(7, "https://login.example.com/2fa", d);
    expect(result).toBe("filled");
    expect(fills).toEqual([{ tabId: 7, frame: { frameId: 0, documentId: "doc-main", url: "https://login.example.com/2fa" }, code: CODE, host: "login.example.com" }]);
  });

  test("targets the frame whose URL was asked for, not the top frame", async () => {
    const frames = [
      { frameId: 0, documentId: "top", url: "https://shop.test/checkout" },
      { frameId: 4, documentId: "bank", url: "https://secure.example.com/otp?x=1" },
    ];
    const { d, fills } = deps({ frames });
    expect(await fillCodeInFrame(1, "https://secure.example.com/otp?x=1", d)).toBe("filled");
    expect(fills.map((f) => f.frame.documentId)).toEqual(["bank"]);
  });

  test("no matching account is 'no-code' and nothing is generated or filled", async () => {
    const { d, fills, coded } = deps({ entries: [entry("other.com"), entry(null)] });
    expect(await fillCodeInFrame(1, "https://example.com/", d)).toBe("no-code");
    expect(fills).toHaveLength(0);
    expect(coded).toHaveLength(0);
  });

  test("the authenticator off, or saved codes unreadable, is 'no-code'", async () => {
    expect(await fillCodeInFrame(1, "https://example.com/", deps({ entries: null }).d)).toBe("no-code");
    const broken = { ...deps().d, entries: () => Promise.reject(new Error("Saved codes could not be read")) };
    expect(await fillCodeInFrame(1, "https://example.com/", broken)).toBe("no-code");
  });

  test("a site that only looks alike never fills", async () => {
    for (const url of ["https://example.com.evil.test/", "https://notexample.com/", "https://evil.test/?example.com"]) {
      const { d, fills, coded } = deps({ frames: [{ frameId: 0, documentId: "d", url }] });
      expect(await fillCodeInFrame(1, url, d)).toBe("no-code");
      expect(fills).toHaveLength(0);
      expect(coded).toHaveLength(0);
    }
  });

  test("a frame URL on the account's site never fills a different-origin frame", async () => {
    // perchd names example.com, but the tab only has a frame from another site.
    const { d, fills } = deps({ frames: [{ frameId: 0, documentId: "d", url: "https://evil.test/" }] });
    expect(await fillCodeInFrame(1, "https://example.com/", d)).toBe("no-field");
    expect(fills).toHaveLength(0);
  });

  test("two accounts for the same site are ambiguous: 'no-code' rather than a guess", async () => {
    const { d, fills } = deps({ entries: [entry("example.com", "alice"), entry("example.com", "bob")] });
    expect(await fillCodeInFrame(1, "https://example.com/", d)).toBe("no-code");
    expect(fills).toHaveLength(0);
  });

  test("the most specific site wins", async () => {
    const work = entry("work.example.com", "work");
    const { d, coded } = deps({ entries: [entry("example.com"), work], frames: [{ frameId: 0, documentId: "d", url: "https://sso.work.example.com/" }] });
    expect(await fillCodeInFrame(1, "https://sso.work.example.com/", d)).toBe("filled");
    expect(coded).toEqual([work]);
  });

  test("no field in the frame is 'no-field'", async () => {
    expect(await fillCodeInFrame(1, "https://example.com/", deps({ field: false }).d)).toBe("no-field");
    const throws = { ...deps().d, fill: () => Promise.reject(new Error("Frame with ID 0 was removed.")) };
    expect(await fillCodeInFrame(1, "https://example.com/", throws)).toBe("no-field");
  });

  test("the frame gone from the tab is 'no-field'", async () => {
    expect(await fillCodeInFrame(1, "https://example.com/", deps({ frames: [] }).d)).toBe("no-field");
  });

  test("the answer never carries the code, whatever happens", async () => {
    const cases = [deps(), deps({ field: false }), deps({ entries: [] }), deps({ frames: [] })];
    for (const { d } of cases) {
      const result = await fillCodeInFrame(1, "https://example.com/", d);
      expect(["filled", "no-code", "no-field"]).toContain(result);
      expect(JSON.stringify(result)).not.toMatch(/\d/);
    }
  });

  test("bad arguments are refused before any lookup", async () => {
    const { d, coded } = deps();
    await expect(fillCodeInFrame(1.5, "https://example.com/", d)).rejects.toThrow(TypeError);
    await expect(fillCodeInFrame(1, "not a url", d)).rejects.toThrow(TypeError);
    await expect(fillCodeInFrame(1, "file:///etc/passwd", d)).rejects.toThrow(TypeError);
    expect(coded).toHaveLength(0);
  });
});
