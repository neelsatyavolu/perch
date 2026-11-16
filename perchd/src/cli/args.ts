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
    if (!known.has(name)) {
      const near = closest(name, [...known]);
      throw new UsageError(`perch: unknown option ${name}${near ? ` (did you mean ${near}?)` : ""}${known.size ? `; this command takes ${[...known].join(", ")}` : ""}`);
    }
    if (spec.flags?.includes(name)) {
      flags.add(name);
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new UsageError(`perch: ${name} needs a value`);
    options.set(name, value);
  }
  return { positionals, flags, options };
}

/** Edit distance between two words: insertions, deletions, substitutions and swaps of neighbours. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/** The name a typo most likely meant: within 2 edits (1 for short words), else undefined. */
export function closest(typed: string, names: string[]): string | undefined {
  const limit = typed.replace(/^-+/, "").length <= 4 ? 1 : 2;
  let best: string | undefined;
  let bestDistance = limit + 1;
  for (const name of names) {
    const dist = distance(typed.toLowerCase(), name.toLowerCase());
    if (dist < bestDistance) [best, bestDistance] = [name, dist];
  }
  return best;
}
