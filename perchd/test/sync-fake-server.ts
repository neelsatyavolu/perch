/**
 * An in-memory stand-in for the sync routes of server/ (commit, changes, blob), for fast engine
 * tests. The real routes are exercised end to end in server/test/client-e2e.test.ts.
 */
import type { FetchLike } from "../src/sync/api";

type Stored = { id: string; version: number; keyVersion: number; seq: number; size: number; deleted: boolean; updatedAt: number; ciphertext?: string };

export function fakeSyncServer(options: { keyVersion?: number; inlineLimit?: number } = {}) {
  const state = { seq: 0, purgeSeq: 0, keyVersion: options.keyVersion ?? 1, items: new Map<string, Stored>(), commits: 0 };
  const inline = options.inlineLimit ?? Infinity;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const out = (s: Stored) => {
    const { ciphertext, ...rest } = s;
    return ciphertext && ciphertext.length > inline ? { ...rest, blob: true } : { ...rest, ...(ciphertext ? { ciphertext } : {}) };
  };

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const [, , , collection, action, id] = url.pathname.split("/");
    if (action === "commit") {
      state.commits++;
      const { items } = JSON.parse(String(init?.body)) as { items: any[] };
      const results = items.map((w) => {
        const key = `${collection}/${w.id}`;
        const current = state.items.get(key);
        if ((current?.version ?? 0) !== w.baseVersion) return { id: w.id, status: "conflict", current: current ? out(current) : null };
        if (!w.deleted && w.keyVersion !== state.keyVersion) return { id: w.id, status: "stale_key", keyVersion: state.keyVersion };
        const stored: Stored = {
          id: w.id, version: w.baseVersion + 1, keyVersion: w.keyVersion ?? state.keyVersion, seq: ++state.seq,
          size: w.ciphertext?.length ?? 0, deleted: !!w.deleted, updatedAt: Date.now(), ...(w.ciphertext ? { ciphertext: w.ciphertext } : {}),
        };
        state.items.set(key, stored);
        return { id: w.id, status: "ok", version: stored.version, seq: stored.seq };
      });
      return json({ results });
    }
    if (action === "changes") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 500);
      if (after > 0 && after < state.purgeSeq) return json({ error: { code: "resync", message: "Sync again from the start." } }, 410);
      const all = [...state.items.entries()].filter(([k, s]) => k.startsWith(`${collection}/`) && s.seq > after).map(([, s]) => s).sort((a, b) => a.seq - b.seq);
      const page = all.slice(0, limit);
      return json({ items: page.map(out), next: page.at(-1)?.seq ?? after, more: all.length > limit });
    }
    if (action === "items" && id) {
      const stored = state.items.get(`${collection}/${id}`);
      if (!stored?.ciphertext) return json({ error: { code: "no_item", message: "gone" } }, 404);
      const bytes = Buffer.from(stored.ciphertext, "base64url");
      return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
    }
    return json({ error: { code: "not_found", message: "no" } }, 404);
  };
  return { fetch, state };
}
