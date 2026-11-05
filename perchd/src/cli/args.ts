/** A small, strict argument parser: known flags and options only, so typos fail loudly. */

export class UsageError extends Error {}

export type Parsed = { positionals: string[]; flags: Set<string>; options: Map<string, string> };

export function parseArgs(argv: string[], spec: { flags?: string[]; options?: string[] } = {}): Parsed {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const positionals: string[] = [];
  const known = new Set([...(spec.flags ?? []), ...(spec.options ?? [])]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-" || /^-\d/.test(arg)) {
      positionals.push(arg);
      continue;
    }
    const [name, inline] = arg.split(/=(.*)/s, 2) as [string, string | undefined];
    if (!known.has(name)) throw new UsageError(`unknown option ${name}`);
    if (spec.flags?.includes(name)) {
      flags.add(name);
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new UsageError(`${name} needs a value`);
    options.set(name, value);
  }
  return { positionals, flags, options };
}
