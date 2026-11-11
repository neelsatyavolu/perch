/**
 * The names a REPL run declares at its top level (`const a`, `let { b, c: d }`, `function e`,
 * `class F`), so the next run can see them. A small scanner, not a parser: it skips strings,
 * template literals and comments, and only looks at depth 0 of brackets. A name it misses is
 * simply not carried over.
 */

const IDENT = /^[A-Za-z_$][\w$]*/;
const DECL = /^(?:const|let|var)\b/;
const FUNC = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const CLASS = /^class\s+([A-Za-z_$][\w$]*)/;
const RESERVED = new Set(["await", "yield", "of", "in"]);

/** The code with strings, templates and comments blanked out (same length), so brackets can be counted. */
function blank(code: string): string {
  let out = "";
  let i = 0;
  const fill = (from: number, to: number) => (out += code.slice(from, to).replace(/[^\n]/g, " "));
  while (i < code.length) {
    const c = code[i]!;
    const next = code[i + 1];
    if (c === "/" && next === "/") {
      const end = code.indexOf("\n", i);
      const stop = end < 0 ? code.length : end;
      fill(i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end < 0 ? code.length : end + 2;
      fill(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < code.length) {
        if (code[j] === "\\") j += 2;
        else if (c === "`" && code[j] === "$" && code[j + 1] === "{") (depth++, (j += 2));
        else if (c === "`" && depth > 0 && code[j] === "}") (depth--, j++);
        else if (code[j] === c && depth === 0) break;
        else j++;
      }
      out += c;
      fill(i + 1, Math.min(j, code.length));
      if (j < code.length) out += c;
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Index just past the bracket that closes the one at `open`. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** Splits at commas outside brackets. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The names a binding pattern (`a`, `{ a, b: c, ...d }`, `[e, [f]]`) introduces. */
function patternNames(pattern: string): string[] {
  const p = pattern.trim();
  if (p.startsWith("{") || p.startsWith("[")) {
    const inner = p.slice(1, closing(p, 0) - 1);
    return splitTop(inner).flatMap((entry) => {
      const e = entry.replace(/^\.\.\./, "");
      // `key: target` in an object pattern; `target = default` anywhere.
      const colon = p.startsWith("{") ? topIndex(e, ":") : -1;
      const target = colon >= 0 ? e.slice(colon + 1) : e;
      const eq = topIndex(target, "=");
      return patternNames(eq >= 0 ? target.slice(0, eq) : target);
    });
  }
  const m = IDENT.exec(p);
  return m && !RESERVED.has(m[0]) ? [m[0]] : [];
}

function topIndex(text: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ch && depth === 0 && !(ch === "=" && (text[i + 1] === "=" || text[i + 1] === ">"))) return i;
  }
  return -1;
}

export function declaredNames(code: string): string[] {
  const text = blank(code);
  const names: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      i++;
      continue;
    }
    const startsWord = depth === 0 && /[A-Za-z_$]/.test(c) && (i === 0 || !/[\w$.]/.test(text[i - 1]!));
    if (!startsWord) {
      i++;
      continue;
    }
    const rest = text.slice(i);
    const fn = FUNC.exec(rest) ?? CLASS.exec(rest);
    if (fn) {
      names.push(fn[1]!);
      i += fn[0].length;
      continue;
    }
    const decl = DECL.exec(rest);
    if (!decl) {
      i += IDENT.exec(rest)?.[0].length ?? 1;
      continue;
    }
    // The declaration runs to a `;` or a line end outside brackets (enough for a REPL line).
    let j = i + decl[0].length;
    let d = 0;
    while (j < text.length) {
      const ch = text[j];
      if (ch === "(" || ch === "[" || ch === "{") d++;
      else if (ch === ")" || ch === "]" || ch === "}") d--;
      else if (d === 0 && (ch === ";" || (ch === "\n" && !/[,=+\-*/&|?:(\[{.]\s*$/.test(text.slice(i, j)) && !/^\s*[,.?:)\]}]/.test(text.slice(j + 1))))) break;
      j++;
    }
    for (const declarator of splitTop(text.slice(i + decl[0].length, j))) {
      const eq = topIndex(declarator, "=");
      names.push(...patternNames(eq >= 0 ? declarator.slice(0, eq) : declarator));
    }
    i = j + 1;
  }
  return [...new Set(names)];
}
