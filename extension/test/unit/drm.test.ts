import { describe, expect, test } from "bun:test";
import { installDrmHook } from "../../src/drm/hook";
import { DRM_MATCHES, noticeText, serviceFor } from "../../src/drm/services";

describe("DRM services", () => {
  test("knows the seven services and their subdomains", () => {
    expect(serviceFor("www.netflix.com")?.name).toBe("Netflix");
    expect(serviceFor("play.hbomax.com")?.name).toBe("Max");
    expect(serviceFor("f1tv.formula1.com")?.name).toBe("F1 TV");
    expect(serviceFor("www.formula1.com")).toBeNull();
    expect(serviceFor("notnetflix.com")).toBeNull();
    expect(DRM_MATCHES).toContain("https://*.disneyplus.com/*");
  });

  test("the notice says what happened, plainly", () => {
    expect(noticeText("Netflix")).toBe("Netflix won't play in this build. Google hasn't approved Perch's video signature yet");
  });
});

function fakeWindow(access: () => Promise<unknown>) {
  class FakeSession extends EventTarget {
    keyStatuses = new Map<string, string>();
  }
  const win = { navigator: { requestMediaKeySystemAccess: access }, MediaKeySession: FakeSession } as unknown as Window & typeof globalThis;
  return { win, FakeSession };
}

describe("DRM hook", () => {
  test("reports a refused Widevine key system and passes the refusal on", async () => {
    const reasons: string[] = [];
    const { win } = fakeWindow(() => Promise.reject(new Error("NotSupportedError")));
    installDrmHook(win, (r) => reasons.push(r));
    const nav = win.navigator as unknown as { requestMediaKeySystemAccess: (k: string, c: unknown[]) => Promise<unknown> };
    await expect(nav.requestMediaKeySystemAccess("com.widevine.alpha", [])).rejects.toThrow("NotSupportedError");
    await Bun.sleep(0);
    expect(reasons).toEqual(["key-system"]);
  });

  test("other key systems and successes stay quiet", async () => {
    const reasons: string[] = [];
    const ok = fakeWindow(() => Promise.resolve("access"));
    installDrmHook(ok.win, (r) => reasons.push(r));
    const nav = ok.win.navigator as unknown as { requestMediaKeySystemAccess: (k: string, c: unknown[]) => Promise<unknown> };
    expect(await nav.requestMediaKeySystemAccess("com.widevine.alpha", [])).toBe("access");
    const bad = fakeWindow(() => Promise.reject(new Error("x")));
    installDrmHook(bad.win, (r) => reasons.push(r));
    const nav2 = bad.win.navigator as unknown as { requestMediaKeySystemAccess: (k: string, c: unknown[]) => Promise<unknown> };
    await nav2.requestMediaKeySystemAccess("org.w3.clearkey", []).catch(() => undefined);
    await Bun.sleep(0);
    expect(reasons).toEqual([]);
  });

  test("an output-restricted key status is reported once per change", () => {
    const reasons: string[] = [];
    const { win, FakeSession } = fakeWindow(() => Promise.resolve("access"));
    installDrmHook(win, (r) => reasons.push(r));
    const session = new FakeSession();
    session.addEventListener("message", () => undefined);
    session.keyStatuses.set("k1", "usable");
    session.dispatchEvent(new Event("keystatuseschange"));
    session.keyStatuses.set("k2", "output-restricted");
    session.dispatchEvent(new Event("keystatuseschange"));
    expect(reasons).toEqual(["output-restricted"]);
  });
});

test("the manifest runs the hook in the page world on exactly the service hosts", async () => {
  const manifest = await Bun.file(new URL("../../static/manifest.json", import.meta.url)).json();
  const [hook, notice] = manifest.content_scripts;
  expect(hook.world).toBe("MAIN");
  expect(hook.js).toEqual(["content/drm-hook.js"]);
  expect(notice.js).toEqual(["content/drm-notice.js"]);
  expect([...hook.matches].sort()).toEqual([...DRM_MATCHES].sort());
  expect([...notice.matches].sort()).toEqual([...DRM_MATCHES].sort());
});
