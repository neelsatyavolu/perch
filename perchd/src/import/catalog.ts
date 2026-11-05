/**
 * Every browser Perch imports from, where it keeps its data under ~/Library, and (for the
 * Chromium family) which Keychain item holds its Safe Storage password.
 */

export type KeychainLabel = { readonly service: string; readonly account: string };

export type Family = "chromium" | "safari" | "firefox" | "aside";

export type BrowserInfo = {
  readonly key: string;
  readonly name: string;
  readonly family: Family;
  /** Relative to ~/Library/Application Support (Chromium, Firefox), ~/Library (Safari) or ~ (Aside's agent data). */
  readonly dir: string;
  /** Chromium family: the "<Browser> Safe Storage" Keychain items to try, in order. */
  readonly safeStorage?: readonly KeychainLabel[];
  /** Opera keeps its one profile in the data folder itself, with no "Default". */
  readonly rootIsProfile?: boolean;
};

const chromium = (key: string, name: string, dir: string, storage: string, extra: Partial<BrowserInfo> = {}): BrowserInfo => ({
  key,
  name,
  family: "chromium",
  dir,
  safeStorage: [{ service: `${storage} Safe Storage`, account: storage }],
  ...extra,
});

export const BROWSERS: readonly BrowserInfo[] = [
  chromium("chrome", "Google Chrome", "Google/Chrome", "Chrome"),
  chromium("chrome-beta", "Chrome Beta", "Google/Chrome Beta", "Chrome"),
  chromium("chrome-canary", "Chrome Canary", "Google/Chrome Canary", "Chrome"),
  chromium("arc", "Arc", "Arc/User Data", "Arc"),
  chromium("dia", "Dia", "Dia/User Data", "Dia"),
  chromium("comet", "Comet", "Comet", "Comet"),
  chromium("atlas", "ChatGPT Atlas", "com.openai.atlas/browser-data/host", "ChatGPT Atlas", {
    safeStorage: [
      { service: "ChatGPT Atlas Safe Storage", account: "ChatGPT Atlas" },
      { service: "ChatGPT Atlas Safe Storage", account: "com.openai.atlas" },
      { service: "com.openai.atlas Safe Storage", account: "com.openai.atlas" },
    ],
  }),
  chromium("brave", "Brave", "BraveSoftware/Brave-Browser", "Brave"),
  chromium("edge", "Microsoft Edge", "Microsoft Edge", "Microsoft Edge"),
  chromium("vivaldi", "Vivaldi", "Vivaldi", "Vivaldi"),
  chromium("opera", "Opera", "com.operasoftware.Opera", "Opera", { rootIsProfile: true }),
  chromium("opera-gx", "Opera GX", "com.operasoftware.OperaGX", "Opera", { rootIsProfile: true }),
  chromium("helium", "Helium", "net.imput.helium", "Helium", {
    safeStorage: [
      { service: "Helium Storage Key", account: "Helium" },
      { service: "Helium Safe Storage", account: "Helium" },
    ],
  }),
  chromium("aside", "Aside", "Aside", "Aside"),
  chromium("chromium", "Chromium", "Chromium", "Chromium"),
  { key: "safari", name: "Safari", family: "safari", dir: "Safari" },
  { key: "firefox", name: "Firefox", family: "firefox", dir: "Firefox" },
  { key: "zen", name: "Zen", family: "firefox", dir: "zen" },
  { key: "aside-agent", name: "Aside memory, skills and chats", family: "aside", dir: ".aside/u" },
];

export function browserByKey(key: string): BrowserInfo | undefined {
  return BROWSERS.find((b) => b.key === key);
}
