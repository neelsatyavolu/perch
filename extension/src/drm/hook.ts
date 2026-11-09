/**
 * Watches the page's own DRM calls and reports a refusal with a DOM event the notice script hears
 * (events cross between the page's world and the extension's). It changes nothing the page sees:
 * every call returns what Chromium returned.
 */

import { DRM_EVENT, REFUSED_STATUSES } from "./services";

type Nav = { requestMediaKeySystemAccess?: (keySystem: string, configs: unknown[]) => Promise<unknown> };
type SessionProto = { keyStatuses?: unknown };

export function installDrmHook(win: Window & typeof globalThis, report: (reason: string) => void = (reason) => win.dispatchEvent(new CustomEvent(DRM_EVENT, { detail: reason }))): void {
  const nav = win.navigator as unknown as Nav;
  const original = nav.requestMediaKeySystemAccess;
  if (typeof original === "function") {
    nav.requestMediaKeySystemAccess = function (this: unknown, keySystem: string, configs: unknown[]) {
      const result = original.call(this, keySystem, configs);
      if (/widevine/i.test(String(keySystem))) result.catch(() => report("key-system"));
      return result;
    };
  }
  const MediaKeySession = (win as unknown as { MediaKeySession?: { prototype: SessionProto } }).MediaKeySession;
  const proto = MediaKeySession?.prototype as { addEventListener: EventTarget["addEventListener"] } | undefined;
  if (!proto) return;
  const add = EventTarget.prototype.addEventListener;
  const watched = new WeakSet<object>();
  // Every session the page creates gets one watcher on its first listener.
  proto.addEventListener = function (this: EventTarget & { keyStatuses?: Map<unknown, string> }, ...args: Parameters<EventTarget["addEventListener"]>) {
    if (!watched.has(this)) {
      watched.add(this);
      add.call(this, "keystatuseschange", () => {
        for (const status of this.keyStatuses?.values() ?? []) {
          if (REFUSED_STATUSES.has(status)) return report(status);
        }
      });
    }
    return add.apply(this, args);
  } as EventTarget["addEventListener"];
}
