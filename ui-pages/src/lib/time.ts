/** Short times for cards and rows: "2 min ago", "Yesterday", "Nov 2". */

const MIN = 60_000;
const HOUR = 60 * MIN;

function dayKey(d: Date, timeZone?: string): string {
  return d.toLocaleDateString("en-CA", { timeZone });
}

export function relativeTime(iso: string, now: Date = new Date(), timeZone?: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const diff = now.getTime() - then.getTime();
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < HOUR) return `In ${Math.max(1, Math.round(ahead / MIN))} min`;
    if (ahead < 24 * HOUR) return `In ${Math.round(ahead / HOUR)} hr`;
    return then.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
  }
  if (diff < MIN) return "Just now";
  if (diff < HOUR) return `${Math.round(diff / MIN)} min ago`;
  if (dayKey(then, timeZone) === dayKey(now, timeZone)) return `${Math.round(diff / HOUR)} hr ago`;
  const yesterday = new Date(now.getTime() - 24 * HOUR);
  if (dayKey(then, timeZone) === dayKey(yesterday, timeZone)) return "Yesterday";
  const sameYear = then.toLocaleDateString("en-US", { year: "numeric", timeZone }) === now.toLocaleDateString("en-US", { year: "numeric", timeZone });
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone });
}

/**
 * A relative time inside a sentence ("used yesterday", "seen Nov 7"): only the leading word is lowercased,
 * so month names keep their capital.
 */
export function inlineTime(iso: string): string {
  const t = relativeTime(iso);
  return /^(Just now|Yesterday|In )/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

/** "Nov 5, 9:46" for run times and audit-style rows. */
export function shortDateTime(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hourCycle: "h23", timeZone });
}
