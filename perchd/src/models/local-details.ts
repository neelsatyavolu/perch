/**
 * Context size and capabilities for local models. Their OpenAI-compatible `/v1/models` lists ids
 * only, so Perch asks each server's own API: LM Studio's `/api/v0/models` and Ollama's `/api/show`.
 * Best effort: a server without these endpoints keeps the plain list.
 */

import type { ModelInfo } from "./catalog";
import type { ListContext } from "./connection";

const DETAIL_TIMEOUT_MS = 3_000;
/** Ollama answers one model per request; a long list only gets details for the first ones. */
const MAX_OLLAMA_SHOWS = 40;

type Details = { context?: number; vision?: boolean; tools?: boolean };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const positive = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);

async function getJson(ctx: ListContext, url: string, init: RequestInit = {}): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) };
  if (ctx.credential) headers.authorization = `Bearer ${ctx.credential}`;
  const res = await ctx.fetch(url, { ...init, headers, signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function lmStudioDetails(ctx: ListContext, root: string): Promise<Map<string, Details>> {
  const body = await getJson(ctx, `${root}/api/v0/models`);
  const data = isRecord(body) && Array.isArray(body.data) ? body.data.filter(isRecord) : [];
  return new Map(
    data.flatMap((m) => {
      if (typeof m.id !== "string") return [];
      const context = positive(m.max_context_length);
      return [[m.id, { ...(context ? { context } : {}), ...(m.type === "vlm" ? { vision: true } : {}) }] as const];
    }),
  );
}

/** Ollama's `num_ctx` (what the server runs with) wins over the model's trained maximum. */
function ollamaDetails(show: unknown): Details {
  if (!isRecord(show)) return {};
  const info = isRecord(show.model_info) ? show.model_info : {};
  const arch = typeof info["general.architecture"] === "string" ? info["general.architecture"] : "";
  const numCtx = typeof show.parameters === "string" ? /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(show.parameters)?.[1] : undefined;
  const context = positive(numCtx ? Number(numCtx) : undefined) ?? positive(info[`${arch}.context_length`]);
  const caps = Array.isArray(show.capabilities) ? show.capabilities : null;
  return { ...(context ? { context } : {}), ...(caps ? { vision: caps.includes("vision"), tools: caps.includes("tools") } : {}) };
}

async function ollamaShows(ctx: ListContext, root: string, models: ModelInfo[]): Promise<Map<string, Details>> {
  const entries = await Promise.all(
    models.slice(0, MAX_OLLAMA_SHOWS).map(async (m) => {
      try {
        return [m.id, ollamaDetails(await getJson(ctx, `${root}/api/show`, { method: "POST", body: JSON.stringify({ model: m.id }) }))] as const;
      } catch {
        return null;
      }
    }),
  );
  return new Map(entries.filter((e): e is readonly [string, Details] => e !== null));
}

/** Adds what LM Studio or Ollama report about each model; anything else comes back unchanged. */
export async function withLocalDetails(ctx: ListContext, models: ModelInfo[]): Promise<ModelInfo[]> {
  if (ctx.provider !== "lmstudio" && ctx.provider !== "ollama") return models;
  const base = ctx.baseUrl.replace(/\/+$/, "");
  if (!base.endsWith("/v1") || models.length === 0) return models;
  const root = base.slice(0, -3);
  let details: Map<string, Details>;
  try {
    details = ctx.provider === "lmstudio" ? await lmStudioDetails(ctx, root) : await ollamaShows(ctx, root, models);
  } catch {
    return models;
  }
  return models.map((m) => {
    const d = details.get(m.id);
    if (!d) return m;
    return { ...m, context: d.context ?? m.context, vision: d.vision ?? m.vision, tools: d.tools ?? m.tools };
  });
}
