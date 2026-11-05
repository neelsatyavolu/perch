/** Link preview data: what a page says about itself, read from the first part of its HTML. */

export type PreviewMeta = {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string;
};

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 400;

/** Regex parsing is enough here: the input is untrusted and only ever shown as text. */
export function parseMeta(html: string, pageUrl: string): PreviewMeta {
  const head = html.slice(0, 512 * 1024);
  const metas = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase();
    const content = attr(tag, "content");
    if (key && content !== null && !metas.has(key)) metas.set(key, content);
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? null;
  const pick = (...keys: string[]) => keys.map((k) => metas.get(k)).find((v) => v && v.trim()) ?? null;

  const title = clean(pick("og:title", "twitter:title") ?? titleTag, MAX_TITLE);
  const description = clean(pick("og:description", "twitter:description", "description"), MAX_DESCRIPTION);
  const image = resolveImage(pick("og:image", "og:image:url", "twitter:image"), pageUrl);
  const siteName = clean(pick("og:site_name"), 80) ?? new URL(pageUrl).hostname;
  return { title, description, image, siteName };
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
}

function clean(value: string | null, max: number): string | null {
  if (!value) return null;
  const text = decodeEntities(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return NAMED[code.toLowerCase()] ?? whole;
  });
}

function resolveImage(value: string | null, pageUrl: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(decodeEntities(value.trim()), pageUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Names that only resolve inside a home or company network. */
const PRIVATE_SUFFIXES = ["localhost", "local", "internal", "lan", "home.arpa", "home", "corp", "intranet", "private"];

/**
 * Loopback, private, link-local and intranet hosts: a web page must not use the preview to probe
 * them. Trailing dots are ignored (`localhost.` is loopback) and single-label names (`router`,
 * `nas`) count as intranet. Public names that resolve to private addresses cannot be caught here;
 * the service worker's network guard and, later, the network service cover what it can.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, "");
  if (!h) return true;
  if (h.startsWith("[")) {
    const v6 = h.slice(1, -1);
    return v6 === "::1" || v6 === "::" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("::ffff:");
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!h.includes(".")) return true;
  return PRIVATE_SUFFIXES.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

const IP4 = "[0-9]{1,3}";
const HOST_PATTERNS = [
  // Single-label names, and names under the intranet suffixes.
  `[^/?#:@.\\[\\]]+\\.*`,
  `(?:[^/?#:@\\[\\]]*\\.)?(?:${PRIVATE_SUFFIXES.map((s) => s.replace(".", "\\.")).join("|")})\\.*`,
  `(?:0|10|127)\\.${IP4}\\.${IP4}\\.${IP4}|169\\.254\\.${IP4}\\.${IP4}|192\\.168\\.${IP4}\\.${IP4}`,
  `172\\.(?:1[6-9]|2[0-9]|3[01])\\.${IP4}\\.${IP4}|100\\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.${IP4}\\.${IP4}`,
  `\\[(?:::1?|f[cd][0-9a-f:.]*|fe[89ab][0-9a-f:.]*|::ffff:[0-9a-f:.]*)\\]`,
];

/**
 * The same address classes as `isPrivateHost`, as RE2 patterns over a canonical URL (Chrome's
 * declarativeNetRequest `regexFilter`). One pattern per rule keeps each under Chrome's size limit.
 */
export const PRIVATE_URL_PATTERNS: readonly string[] = HOST_PATTERNS.map((host) => `^[a-z]+://(?:[^/?#@]*@)?(?:${host})(?::[0-9]+)?(?:[/?#]|$)`);

/** Whether a page at `pageUrl` may preview `linkUrl`. */
export function mayPreview(pageUrl: string, linkUrl: string): boolean {
  let link: URL;
  let page: URL;
  try {
    link = new URL(linkUrl);
    page = new URL(pageUrl);
  } catch {
    return false;
  }
  if (link.protocol !== "http:" && link.protocol !== "https:") return false;
  return !isPrivateHost(link.hostname) || isPrivateHost(page.hostname);
}
