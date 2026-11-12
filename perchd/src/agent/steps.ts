/** What the chat shows of a step when it is opened: what the step ran and what came back. */

/** Tools whose arguments are what the user or their vault typed; their details stay hidden. */
const TYPED = new Set(["type", "type_text", "fill_code", "sign_in", "fill_card"]);
const DETAIL_LIMIT = 4000;
/** What a step returned, as shown when the step is opened. */
export const OUTPUT_LIMIT = 4000;

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…` : text);

/**
 * What a step ran, for the chat's expanded step: the code of a script, the query of a search, the
 * URL of a page, or else the arguments. Never what was typed.
 */
export function stepDetail(tool: string, args: unknown): string | undefined {
  if (TYPED.has(tool)) return undefined;
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  if (typeof a.code === "string" && a.code.trim()) return clip(a.code.trim(), DETAIL_LIMIT);
  if (typeof a.command === "string" && a.command.trim()) return clip(a.command.trim(), DETAIL_LIMIT);
  if (typeof a.query === "string" && a.query.trim()) return a.query.trim();
  if (typeof a.url === "string" && a.url.trim()) return a.url.trim();
  if (tool === "batch" && Array.isArray(a.actions)) {
    return a.actions
      .map((x) => {
        const action = (x && typeof x === "object" ? x : {}) as { name?: unknown; args?: Record<string, unknown> };
        const name = String(action.name ?? "?");
        if (TYPED.has(name)) return `${name}${typeof action.args?.ref === "string" ? ` ${action.args.ref}` : ""}`;
        return `${name} ${JSON.stringify(action.args ?? {})}`;
      })
      .join("\n");
  }
  const rest = Object.fromEntries(Object.entries(a).filter(([k]) => k !== "title"));
  return Object.keys(rest).length ? clip(JSON.stringify(rest), 300) : undefined;
}
