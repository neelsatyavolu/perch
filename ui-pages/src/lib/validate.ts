/** Checks for everything people type into Perch's pages, before it reaches perchd. */

export type Check<T = string> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const pass = <T>(value: T): Check<T> => ({ ok: true, value });
const fail = (error: string): Check<never> => ({ ok: false, error });

const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Site patterns use Lulltab's forms: `github.com` (and subdomains), `=host` (exact),
 * `*.host` (subdomains only), `host/path` (path and below) and full URL prefixes.
 */
export function checkSitePattern(input: string): Check {
  const raw = input.trim();
  if (!raw) return fail("Enter a site, like github.com");
  if (raw.length > 500 || /\s/.test(raw)) return fail("A site can't contain spaces");
  if (/^https?:\/\//i.test(raw)) {
    return parseUrl(raw) ? pass(raw) : fail("That link isn't a valid web address");
  }
  const exact = raw.startsWith("=");
  const rest = exact ? raw.slice(1) : raw;
  const slash = rest.indexOf("/");
  const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  const path = slash === -1 ? "" : rest.slice(slash);
  if (!HOST.test(host) || (exact && host.startsWith("*."))) return fail("Enter a site, like github.com or *.example.com");
  return pass(`${exact ? "=" : ""}${host}${path}`);
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** https anywhere, or plain http only for servers on this Mac. */
function checkWebUrl(input: string, what: string): Check {
  const raw = input.trim();
  const url = parseUrl(raw);
  if (!url || !/^https?:$/.test(url.protocol)) return fail(`Enter the ${what}'s web address, starting with https://`);
  if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) return fail(`Use https for a ${what} that isn't on this Mac`);
  return pass(raw);
}

export const checkMcpUrl = (input: string): Check => checkWebUrl(input, "server");
export const checkEndpointUrl = (input: string): Check => checkWebUrl(input, "endpoint");

export function checkApiKey(input: string): Check {
  const key = input.trim();
  if (!key) return fail("Paste the API key");
  if (/\s/.test(key)) return fail("An API key can't contain spaces");
  if (key.length < 8 || key.length > 512) return fail("That doesn't look like a whole API key");
  return pass(key);
}

export function checkCommand(input: string): Check {
  const cmd = input.trim();
  if (!cmd) return fail("Enter the command that starts the server");
  if (/[\r\n]/.test(cmd)) return fail("The command must be on one line");
  if (cmd.length > 2000) return fail("That command is too long");
  return pass(cmd);
}

export function checkSecretName(input: string): Check {
  const name = input.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(name)) return fail("Use letters, numbers, - and _, like GITHUB_TOKEN");
  return pass(name);
}

export function checkTitle(input: string, max = 120): Check {
  const title = input.trim();
  if (!title) return fail("Give it a name");
  if (title.length > max) return fail(`Keep the name under ${max} characters`);
  return pass(title);
}

export function checkTime(input: string): Check {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(input.trim()) ? pass(input.trim()) : fail("Use a 24-hour time, like 08:00");
}

export function checkSkillLocation(origin: "folder" | "url" | "git", input: string): Check {
  const loc = input.trim();
  if (origin === "folder") return /^(\/|~\/)\S/.test(loc) ? pass(loc) : fail("Enter a folder path, like ~/skills/pdf");
  if (origin === "url") {
    const url = parseUrl(loc);
    return url?.protocol === "https:" ? pass(loc) : fail("Enter an https link to a SKILL.md or a folder");
  }
  if (/^git@[\w.-]+:[\w./-]+$/.test(loc) || parseUrl(loc)?.protocol === "https:") return pass(loc);
  return fail("Enter a git repository, like https://github.com/you/skills.git");
}
