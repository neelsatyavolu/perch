/** Checks at the memory boundary: where a page may live, what a fact may say, and what never becomes a memory. */

export const CATEGORIES = ["user", "rules", "people", "companies", "places", "sites", "projects", "routines", "concepts", "writing", "episodic", "log"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Categories the agent and extraction may file into; logs are written by Perch only. */
export const FILEABLE: readonly Category[] = CATEGORIES.filter((c) => c !== "log");

export const MAX_FACT = 500;
export const MAX_TITLE = 120;

const TOP: Record<string, Category> = { "USER.md": "user", "MEMORY.md": "rules" };
const PATH = /^([a-z]+)\/([a-z0-9][a-z0-9-]{0,79})\.md$/;

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

/** One line of plain text: no newlines, no HTML comment markers (they carry fact metadata). */
export function cleanText(text: string, max = MAX_FACT): string {
  return text.replace(/<!--|-->/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function slugify(title: string): string {
  const slug = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return slug || "untitled";
}

export function pagePath(category: Category, title: string): string {
  if (category === "user") return "USER.md";
  if (category === "rules") return "MEMORY.md";
  return `${category}/${slugify(title)}.md`;
}

/** The category of a logical page path, or null when the path is not one Perch writes. */
export function categoryOf(path: string): Category | null {
  if (TOP[path]) return TOP[path]!;
  const match = PATH.exec(path);
  if (!match) return null;
  const category = match[1]!;
  return isCategory(category) && category !== "user" && category !== "rules" ? category : null;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(password|passcode|passphrase|pin|otp|one[- ]time code|verification code|security code|2fa code|cvv|cvc|recovery (key|code)s?)\b\s*(is|was|=|:)\s*\S+/i,
  // "Passwords: gmail: hunter2!", "the wifi password for home is Tr0ub4dor", "app password abcd efgh".
  /\b(pass(word|code|phrase)s?|app password)\b(\W+\w+){0,5}?\s*(is|was|=|:)\s*\S{4,}/i,
  /\bapp password\s+[a-z]{4}(\s?[a-z]{4}){3}\b/i,
  /\bPIN\b\W{0,3}\d{4,8}\b/i,
  /\b(backup|recovery|security) codes?\b\W+\d{4}/i,
  /\b(security (question|answer)|maiden name)\b/i,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bxai-[A-Za-z0-9]{16,}/,
  /\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b[A-Fa-f0-9]{40,}\b/,
];
const CARD = /\b(?:\d{13,19}|\d{4}(?:[ -]\d{4}){2}[ -]\d{1,7}|\d{4}[ -]\d{6}[ -]\d{5})\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** True for text that holds a credential, key, card number or code. Those never become memories. */
export function looksSecret(text: string): boolean {
  if (SECRET_PATTERNS.some((p) => p.test(text))) return true;
  for (const match of text.matchAll(CARD)) if (luhn(match[0].replace(/\D/g, ""))) return true;
  return false;
}
