import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://127.0.0.1/ui/chat.html" });


/**
 * Text that types out in the app (message.tsx useTyped) shows at once, as with reduced motion.
 * Called here and again by test files, since the smoke test registers a new window.
 */
export function reduceMotion(): void {
  const media = window.matchMedia.bind(window);
  window.matchMedia = (q: string) => (q === "(prefers-reduced-motion: reduce)" ? ({ ...media(q), matches: true, media: q } as MediaQueryList) : media(q));
  globalThis.matchMedia = window.matchMedia;
}
reduceMotion();
