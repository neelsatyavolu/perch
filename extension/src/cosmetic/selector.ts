/**
 * Checks element-hiding selectors before they reach a stylesheet, and turns selector lists into CSS.
 * One bad selector in a selector list makes Chrome drop the whole rule, so anything this cannot
 * vouch for is left out, and selectors go out in groups so a miss costs at most one group.
 */

export type SelectorProblem = "procedural" | "invalid-selector";

/** Pseudo-classes and pseudo-elements Chrome supports that element-hiding filters use. */
const PSEUDOS = new Set([
  "not", "is", "where", "has", "-webkit-any",
  "nth-child", "nth-last-child", "nth-of-type", "nth-last-of-type",
  "first-child", "last-child", "only-child", "first-of-type", "last-of-type", "only-of-type",
  "empty", "root", "scope", "link", "visited", "any-link", "target", "defined",
  "hover", "active", "focus", "focus-within", "focus-visible",
  "checked", "disabled", "enabled", "required", "optional", "read-only", "read-write",
  "placeholder-shown", "default", "indeterminate", "valid", "invalid", "in-range", "out-of-range",
  "lang", "dir",
  "before", "after", "first-line", "first-letter", "marker", "placeholder", "backdrop",
]);

/** Adblock Plus, uBlock Origin and AdGuard extensions to CSS that only their engines run. */
const PROCEDURAL = new Set([
  "has-text", "contains", "xpath", "upward", "remove", "remove-attr", "remove-class", "style",
  "matches-css", "matches-css-before", "matches-css-after", "matches-attr", "matches-path", "matches-prop",
  "matches-media", "min-text-length", "nth-ancestor", "watch-attr", "watch-attrs", "others", "if", "if-not", "shadow", "spath",
]);

const NAME = /^::?(-?[a-zA-Z][a-zA-Z0-9-]*)/;

/** Returns why a selector cannot be used as plain CSS, or null when it can. */
export function checkSelector(selector: string): SelectorProblem | null {
  const text = selector.trim();
  // `+js(…)` scriptlets, `^…` HTML filters and `sel {style}` CSS injection.
  if (!text) return "invalid-selector";
  if (text.startsWith("+js(") || text.startsWith("^") || /\{[^{}]*\}$/.test(text)) return "procedural";
  if (/^[,>+~]|[,>+~]\s*$/.test(text) || /,\s*,/.test(text)) return "invalid-selector";
  let quote = "";
  let brackets = 0;
  /** One entry per open parenthesis: true when it holds a :has() argument. */
  const parens: boolean[] = [];
  let hasNext = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") {
      if (i === text.length - 1) return "invalid-selector";
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    // Braces, semicolons and comments would end the rule early or open a new one.
    if ("{};/@<!".includes(c)) return "invalid-selector";
    if (brackets) {
      if (c === "[") return "invalid-selector";
      if (c === "]") brackets--;
      continue;
    }
    if (c === "[") brackets++;
    else if (c === "]") return "invalid-selector";
    else if (c === "(") {
      parens.push(hasNext);
      hasNext = false;
    } else if (c === ")" && parens.pop() === undefined) return "invalid-selector";
    else if (c === ":") {
      const name = NAME.exec(text.slice(i))?.[1]?.toLowerCase();
      if (!name) return "invalid-selector";
      if (name.startsWith("-abp-") || PROCEDURAL.has(name)) return "procedural";
      if (!PSEUDOS.has(name)) return "invalid-selector";
      // Chrome rejects :has() inside :has().
      if (name === "has" && parens.includes(true)) return "invalid-selector";
      hasNext = name === "has";
      i += (text[i + 1] === ":" ? 2 : 1) + name.length - 1;
    }
  }
  return quote || brackets || parens.length ? "invalid-selector" : null;
}

export const GROUP_SIZE = 100;

/** `a,b,…{display:none!important}`, one rule per GROUP_SIZE selectors. */
export function hideCss(selectors: readonly string[], size = GROUP_SIZE): string {
  const rules: string[] = [];
  for (let i = 0; i < selectors.length; i += size) rules.push(`${selectors.slice(i, i + size).join(",")}{display:none!important}`);
  return rules.join("\n");
}
