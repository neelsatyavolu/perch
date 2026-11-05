/**
 * Finds tokens inside an MCP server's command line or URL and replaces each with `${NAME}`, the way
 * api.ts says perchd must before it stores or returns a target. The pages also run it on every
 * target they show, so a token never reaches the screen even if one slips through.
 */

export type Redacted = { readonly target: string; readonly secrets: readonly { readonly name: string; readonly value: string }[] };

/** Flag, parameter and variable names that hold secrets: --api-key, access_token, GITHUB_TOKEN, … */
const SECRET_NAME = /(?:^|[-_])(?:api[-_]?key|apikey|key|token|secret|password|passwd|pwd|auth|credentials?)(?:[-_]|$)/i;
/** Values that are tokens on sight, whatever they are called. */
const TOKEN_PREFIX = /^(?:sk-|sk_|ghp_|gho_|ghs_|ghu_|github_pat_|xox[abpors]-|glpat-|AKIA|AIza|pk_live_|rk_live_|hf_|lin_api_)[A-Za-z0-9._-]{8,}$/;
const PLACEHOLDER = /^\$\{?[A-Za-z0-9_]+\}?$/;

const nameOf = (raw: string) => raw.replace(/^-+/, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").toUpperCase() || "TOKEN";

function collector() {
  const secrets: { name: string; value: string }[] = [];
  const take = (wanted: string, value: string): string => {
    const base = nameOf(wanted);
    let name = base;
    for (let n = 2; secrets.some((s) => s.name === name); n++) name = `${base}_${n}`;
    secrets.push({ name, value });
    return `\${${name}}`;
  };
  return { secrets, take };
}

type Take = ReturnType<typeof collector>["take"];
const isSecretValue = (v: string) => v.length > 0 && !PLACEHOLDER.test(v);

function redactUrl(raw: string, take: Take): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const password = url.password ? `:${take("URL_PASSWORD", decodeURIComponent(url.password))}` : "";
  const user = url.username ? `${url.username}${password}@` : "";
  const path = url.pathname.split("/").map((seg) => (TOKEN_PREFIX.test(seg) ? take("TOKEN", seg) : seg)).join("/");
  const query = url.search
    ? `?${url.search.slice(1).split("&").map((pair) => {
        const at = pair.indexOf("=");
        if (at === -1) return pair;
        const key = pair.slice(0, at);
        const value = decodeURIComponent(pair.slice(at + 1));
        return (SECRET_NAME.test(key) && isSecretValue(value)) || TOKEN_PREFIX.test(value) ? `${key}=${take(key, value)}` : pair;
      }).join("&")}`
    : "";
  return `${url.protocol}//${user}${url.host}${path}${query}${url.hash}`;
}

export function redactTarget(target: string): Redacted {
  const { secrets, take } = collector();
  const words = target.split(/(\s+)/);
  const out = [...words];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (/^\s*$/.test(word)) continue;
    const prev = words.slice(0, i).reverse().find((x) => !/^\s*$/.test(x)) ?? "";
    const eq = word.indexOf("=");
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(word)) out[i] = redactUrl(word, take);
    else if (/^-{1,2}[A-Za-z]/.test(prev) && !prev.includes("=") && SECRET_NAME.test(prev) && !word.startsWith("-") && isSecretValue(word)) out[i] = take(prev, word);
    else if (/^bearer$/i.test(prev) && isSecretValue(word)) out[i] = take("BEARER_TOKEN", word);
    else if (eq > 0 && SECRET_NAME.test(word.slice(0, eq)) && isSecretValue(word.slice(eq + 1))) out[i] = `${word.slice(0, eq + 1)}${take(word.slice(0, eq), word.slice(eq + 1))}`;
    else if (TOKEN_PREFIX.test(word)) out[i] = take("TOKEN", word);
  }
  return { target: out.join(""), secrets };
}
