# Perch plan: memory and routines (perchd)

**Goal:** Perch remembers what matters about the user, privately, and can run saved tasks on a schedule. Everything is stored encrypted on the Mac, searchable locally, editable by the user, and reachable from the agent loop and the Memory and Routines pages through typed functions.

**Spec:** `docs/superpowers/specs/2026-11-02-perch-design.md` section 8 (memory, set up your memory, routines), 7.4 (permission modes), 11.1 (encryption at rest). Roadmap plan 5.

**Branch:** `perch/memory-routines`.

## Aside parity checklist

Aside's help pages (docs.aside.com/help/memory, /help/automation, components changelog), checked 2026-11-05:

| Aside | Perch | Status |
|---|---|---|
| Memory on/off, created from chats and tasks | Extraction after each finished chat with the fast model, a pause switch, off in incognito | this plan |
| Episodic retention: never, 30 days, 90 days | Same three choices; dreaming expires older episodic entries | this plan |
| Overview (inspect, edit), History (memory changes), Configure | Typed API: list, read, edit, delete facts and pages, wipe, a change log, settings | this plan (page UI is plan 3b) |
| Relevant memories come in with each message | USER.md and MEMORY.md plus the top matches for the task go into the system prompt | this plan |
| memory_search tool | `memory_search` for the agent; `memory_save` asks in Ask mode | this plan |
| "Set up your memory" (one prompt, scores until 9/10) | Source switches, a draft profile grouped as the spec says, a review step where every item is editable, nothing saved before "Save to memory", and a gap list instead of a hidden score | this plan |
| Local memory search | FTS5 (bun:sqlite) held in RAM, so no plaintext index on disk | this plan |
| Dreaming (Claude Sonnet dreaming) | Rule pass (duplicates, expiry, retention) plus a model pass that may only merge or retire existing facts; a dated log | this plan |
| Cron routines, run now, pause/resume, edit, delete | Same, with next-run times and a readable schedule | this plan |
| Explicit permissions for a scheduled run | Each routine has its own mode; unattended runs decline anything that needs approval and never pay | this plan |
| Skips overlapping runs | One run per routine at a time, one routine at a time overall | this plan |
| Runs, outputs kept | Each run saved as an encrypted chat record with its steps and answer | this plan |
| Heartbeat routines (wake an existing chat) | needs the chat store from plan 3b | deferred |
| Routine suggestions ("Find routines to automate") | needs chat history across chats | deferred |
| Local routines stop when the computer sleeps | Perch adds a missed-run policy: run once on wake, or skip | this plan |

## Design

- **Encryption.** One AES-256-GCM key per profile, 32 random bytes kept in the macOS Keychain (service `Perch`, account `data-key:<profile>`). Every record is its own file named by a random id, holding `magic | iv | ciphertext+tag`, with the record's id and kind as associated data so files cannot be swapped. Titles and paths live inside the ciphertext, so file names reveal nothing. Writes go to a temp file and are renamed; folders are 0700, files 0600. If records exist but the key is missing, Perch stops with a plain error instead of making a new key and losing the data.
- **Keychain.** `KeyStore` interface with a `/usr/bin/security` implementation that passes secrets on stdin (never argv) and an in-memory mock for tests.
- **Memory pages.** One record per page: `USER.md`, `MEMORY.md`, and topic pages under `people/`, `companies/`, `sites/`, `projects/`, `routines/`, `concepts/`, `places/`, `writing/`, `episodic/`. Each page is markdown with frontmatter and "Current" and "History" sections; each fact line carries its date, source and optional expiry in an HTML comment.
- **Search.** An in-memory FTS5 table rebuilt from the decrypted pages at open and kept in step on every write. An `Embedder` interface lets a local model rerank results later.
- **Secrets never become memories.** Extraction, setup and `memory_save` drop facts that look like passwords, keys, card numbers or one-time codes.

## File layout

```
perchd/src/memory/
  keychain.ts   KeyStore, macOS Keychain via security(1), mock
  crypto.ts     AES-256-GCM records, key load/create
  records.ts    encrypted record folder: put, get, list, remove, atomic writes
  page.ts       memory page type, markdown (de)serialisation, fact helpers
  sanitize.ts   path/category/text validation, secret filter
  search.ts     in-memory FTS5 index, query escaping, optional embedder rerank
  store.ts      MemoryStore: pages, facts, settings, change log, wipe
  extract.ts    extraction from a finished chat (model tool call)
  taxonomy.ts   TAXONOMY.md: default filing rules; the user's own copy is an encrypted record
  dream.ts      consolidation: rules + model merges, dated log
  setup.ts      "Set up your memory": sources, questionnaire, draft, review, save
  sources.ts    Chromium history and bookmarks readers, tab list, chat summaries
  agent.ts      memory tools and per-chat memory access for runTask
  api.ts        typed functions for the Memory page
perchd/src/routines/
  schedule.ts   cron parsing, next run, plain description
  store.ts      encrypted routines and runs
  runner.ts     one run under the routine's mode, unattended approvals, result as chat
  scheduler.ts  due runs, missed-run policy, no overlap
  api.ts        typed functions for the Routines UI
perchd/test/memory-*.test.ts, routines-*.test.ts
```

Shared files touched: `perchd/src/agent/loop.ts` (optional `memory` option: extra tools, recalled context, extraction hook). Nothing else shared.

## Tasks

1. Keychain + crypto: round trip, wrong key fails, tampered byte fails, swapped files fail, secret only on stdin.
2. Records + pages: atomic encrypted files, markdown round trip, canary test that no plaintext lands on disk (files, names, temp files, no sqlite files).
3. Search: FTS5 ranking, prefix, odd query characters, category filter, updates and deletes, embedder rerank hook.
4. Store: add facts with dedupe, edit, delete, wipe, settings, change log, retention.
5. Extraction: fake model tool call → filed facts; secrets dropped; paused and incognito skip; bad model output is ignored safely.
6. Dreaming: duplicates merged, expired facts moved to History, retention, model merges limited to existing facts, dated log.
7. Setup: source switches respected, history reduced to domains without queries, draft grouped, edit/remove/add, nothing saved until save, gaps listed.
8. Agent wiring: `memory_search` runs freely, `memory_save` asks in Ask mode and runs in Guard, recalled memories in the system prompt, extraction after the chat.
9. Routines: cron next-run (lists, ranges, steps, weekdays, DST, month ends), store, runner (payments never approved unattended, mode respected, run saved as chat), scheduler (due, overlap, missed run once or skip).
10. Typed APIs with input validation and a result envelope.

## Deferred, and why

- **Local embeddings.** onnxruntime plus even the smallest useful model (all-MiniLM-L6, about 23 MB, 90 MB with the runtime) adds weight to a binary the spec wants light, and FTS5 is enough for hundreds of pages. The `Embedder` interface and the rerank step are in place; a model can plug in later.
- **Secure Enclave wrapping and Keychain access scoped to Perch's signature.** Needs native code in the signed app (plan 3b). Until then the key is a Keychain item created through `security(1)`.
- **Heartbeat routines and routine suggestions.** Both need the chat store and chat history (plan 3b).
- **Mail, calendar, Messages, AI-service exports, Aside import and web search as setup sources.** They need the site skills (plan 4) and import readers (plan 6). The source list has their switches reserved; web search stays off by default.
- **The Memory and Routines pages themselves.** WebUI belongs to plan 3b; this plan ships the typed functions they call.
- **MCP `memory_search` for outside agents.** The function is ready; wiring it into `mcp.ts` belongs to the MCP track.
- **Scheduled browsing-history extraction** (spec 8, opt-in). Setup reads history once with the user's review; a background job that files facts from history without review needs its own consent design, so there is no setting for it yet.
- **Wiring into the real entry points.** No caller of `runTask` (`cli.ts`, `external.ts`, `mcp.ts`) passes `memory` yet, and nothing calls `openPerchData`, so memory and routines are reached only from tests until the daemon/app track opens them at startup (`openPerchData(...).start()`), passes `chatMemory()` into sidebar chats and serves the two APIs. Those are shared files owned by other tracks.
- **`perch memory search|read` CLI.** Belongs to the CLI track; it can call `createMemoryApi`.
- **Encrypting the shared audit log.** The audit log belongs to the agent core. Memory calls write only the action and category to it, never the query or the fact.

## Notes from review (Codex, 2026-11-05), all fixed

Memory contents in the plaintext audit log; a lost key replaced when only routines existed; extraction filing standing rules or facts the user declined; concurrent routine saves sharing a temp file; dreaming overwriting edits made while the model answered; merge cycles deleting both pages; queued runs using stale settings. Skip-mode routines can still send and delete unattended by design (the user chose Skip); payments never run unattended in any mode, proved on a real page in `test/routines-browser.test.ts`.

## Notes from the second review (2026-11-05), all fixed

- Unattended routine runs could save to USER.md or topic pages with no approval in Guard and Skip, so a page could plant text in every later chat. Now every `memory_save` in an unattended run asks, so it is declined and listed in the run's `declined`; in any chat, saving to USER.md asks like saving to MEMORY.md (`test/memory-agent.test.ts`, `test/routines-service.test.ts`).
- Dreaming's model pass could rewrite a standing rule. MEMORY.md is no longer shown to the model or changed by it, and a merged fact may only use words from the facts it merges plus a few joining words (`test/memory-dream.test.ts`).
- Routine writes were read-modify-write on stale copies, so a pause or mode change made during a tick could be undone. `RoutineStore.update(id, change)` applies changes to the latest copy inside the write queue; the scheduler, runner and API all use it (`test/routines-run.test.ts`, `test/routines-api.test.ts`).
- Unreadable memory settings silently turned extraction back on. They are now listed in `damaged` and memory stays paused with extraction off until the user saves settings (`test/memory-store.test.ts`).
- A routine still running when its next time came was dropped with no record. That time is now recorded as skipped (`test/routines-run.test.ts`).
- TAXONOMY.md was only a code constant. It is now readable and editable through `getTaxonomy`, `setTaxonomy` and `resetTaxonomy`, stored encrypted, kept through a wipe, and used by extraction, setup and `memory_save` (`test/memory-taxonomy.test.ts`).
