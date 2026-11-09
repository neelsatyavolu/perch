# Perch plan 3a: agent core (`perchd`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tested TypeScript core that drives a Chromium browser over a private CDP pipe. It reads pages as compact snapshots, acts with real input events, asks before risky actions, logs every action, and runs a task loop with Codex, Grok or Claude API models.

**Architecture:** `perchd/` is a Bun + TypeScript package. It launches Chromium with `--remote-debugging-pipe` and speaks CDP over file descriptors 3 and 4. It never opens a TCP port.
- **Page state:** each page becomes a snapshot built from the accessibility tree (`Accessibility.getFullAXTree`) joined with layout from `DOMSnapshot.captureSnapshot`. Interactive elements get short refs (`e12`) that map to backend node ids.
- **Actions:** these use the `Input` domain, so pages see trusted events.
- **Models:** they share one tool schema. One adapter covers the OpenAI Responses API (Codex at `chatgpt.com/backend-api/codex/responses`, Grok at `api.x.ai/v1/responses`, same shapes as Flint's `packages/core/src/ai/stream.ts`), and one covers the Anthropic Messages API.
- **Tests:** they run against Chrome for Testing in headless mode and a local fixture server. They never touch the real Perch build, the owner's browser or the screen.

**Tech Stack:** Bun 1.3, TypeScript (strict), `bun test`, Chrome for Testing (installed with `bunx @puppeteer/browsers`), no runtime dependencies except `@neelsatyavolu/shared-ai-auth`.

**Spec:** `docs/superpowers/specs/2026-11-02-perch-design.md`, sections 7.1–7.4 and the owner priorities. Roadmap: `docs/superpowers/plans/2026-11-03-perch-roadmap.md`.

## Global Constraints

- Owner priority 2: the best computer use across most models. The snapshot and tools are model-agnostic. No provider-specific tricks live in the page layer.
- CDP only over `--remote-debugging-pipe`. Never `--remote-debugging-port`.
- The model never sees a saved secret:
  - after a fill, password, card and one-time-code fields are `"••••"` in snapshots, masked in screenshots, and unreadable from the REPL;
  - inputs with `type=password` or `autocomplete` of `cc-*`, `one-time-code` or `current-password`/`new-password` are always redacted.
- Permission modes are Ask, Guard (default) and Skip confirmation. Payments, purchases and password changes always ask.
- Every action is appended to an audit log as JSON lines: time, tab, site, action, client, approved.
- Never print, log or store a token. Tests use fake models and recorded responses; no test calls a real model.
- Never drive the GUI or capture the screen. Chrome for Testing runs with `--headless=new`.
- CPU-light work only while the Chromium build runs: `bun test` runs at most 2 browser instances at once.
- Files stay under 400 lines; functions under 50.
- Commits use `type: description`, with no attribution lines.

## Review Focus

1. **A ref goes stale after the page changes.** The action fails with `ref e12 is gone; take a new snapshot`, never clicks the wrong element. Test in task 5.
2. **Very large pages** (10,000 rows). The snapshot stays under its character budget, says how much was left out, and finishes in under 1.5 s. Test in task 4.
3. **Iframes and shadow DOM.** Elements inside them get refs and can be clicked. Test in task 4.
4. **A model calls a tool with bad arguments or an unknown tool.** It gets a clear error back as the tool result and the loop continues. Test in task 10.
5. **The browser crashes or the page navigates mid-action.** The call fails with a clear error and the next call works. Test in task 3.

---

## File structure

```
perchd/
  package.json  tsconfig.json  README.md
  src/
    cdp/pipe.ts          launch Chromium, frame messages on fd 3/4
    cdp/connection.ts    send/receive, sessions, events
    browser/browser.ts   launch, tabs, attach
    browser/tab.ts       navigate, wait for load, eval
    page/snapshot.ts     AX + DOMSnapshot to compact text with refs
    page/refs.ts         ref ↔ backend node id, staleness
    page/secrets.ts      which fields are secret, masking
    page/actions.ts      click, type, select, press, scroll, hover, upload, wait, back
    page/screenshot.ts   masked screenshots, coordinate actions
    page/repl.ts         isolated-world JS with the secret guard
    agent/tools.ts       tool schemas and dispatch
    agent/permissions.ts modes, risk classification, approvals
    agent/audit.ts       JSON-lines audit log
    agent/loop.ts        the task loop, context trimming, step events
    models/types.ts      Model interface, messages, tool calls
    models/responses.ts  OpenAI Responses API (Codex, Grok)
    models/anthropic.ts  Anthropic Messages API
    models/fake.ts       scripted model for tests
    cli.ts               perchd-dev run "<task>" (development harness)
  test/
    fixtures/server.ts   Bun server for fixture pages
    fixtures/pages/*.html mail, form, shop, long list, iframe, shadow DOM
    helpers.ts           shared browser per test file
    *.test.ts
```

---

### Task 1: Package, Chrome for Testing, CDP pipe

**Files:** `perchd/package.json`, `perchd/tsconfig.json`, `src/cdp/pipe.ts`, `src/cdp/connection.ts`, `test/cdp.test.ts`, `test/helpers.ts`

**Interfaces:**
- Produces:
  - `encode(msg: object): Buffer`, which appends `\0`.
  - `class FrameDecoder { push(chunk: Buffer): object[] }`, which handles split and joined frames.
  - `launchChromium(opts: { executable: string; userDataDir: string; headless: boolean; args?: string[] }): Promise<CdpConnection>`.
  - `CdpConnection.send<T>(method: string, params?: object, sessionId?: string): Promise<T>`, `.on(event: string, fn: (params, sessionId?) => void): () => void`, `.close(): Promise<void>` and `.closed: Promise<Error | null>`.
  - `findChromeForTesting(): Promise<string>`, which reads `PERCH_CHROME` or the newest install under `~/.cache/perch-cft`.

- [ ] Write failing tests:
  - `encode` ends with exactly one NUL;
  - the decoder splits two messages in one chunk, and joins one message across three chunks;
  - an integration test launches headless CfT and `Browser.getVersion` returns a `product` starting with `HeadlessChrome/`;
  - after `close()`, a pending `send` rejects with `browser closed`.
- [ ] Install CfT: `bunx @puppeteer/browsers install chrome@stable --path ~/.cache/perch-cft`. Run the tests and confirm they fail on missing modules.
- [ ] Implement. Spawn with `stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"]`, write on fd 3 and read fd 4. Args: `--remote-debugging-pipe`, `--user-data-dir`, `--no-first-run`, `--no-default-browser-check`, `--headless=new` and `about:blank`.
- [ ] Tests pass, then commit: `feat(perchd): CDP over a private pipe`.

### Task 2: Browser, tabs and the fixture server

**Files:** `src/browser/browser.ts`, `src/browser/tab.ts`, `test/fixtures/server.ts`, `test/fixtures/pages/{mail,form,shop,long,iframe,shadow}.html`, `test/browser.test.ts`

**Interfaces:**
- Consumes: `CdpConnection`.
- Produces:
  - `Browser.launch(opts) → Browser`, `browser.newTab(url?) → Tab`, `browser.tabs(): TabInfo[]`, `browser.close()`.
  - `TabInfo = { id: string; url: string; title: string }`.
  - `tab.navigate(url, { waitUntil: "load" | "networkidle" }) → void`, `tab.evaluate<T>(expression) → T`, `tab.url()`, `tab.title()`, `tab.close()` and `tab.session: string`. Flattened sessions come from `Target.setAutoAttach({ flatten: true })`.
  - `startFixtures() → { url(path): string; stop() }`.

- [ ] Write failing tests:
  - a new tab navigates to `/mail.html`, and `title()` is `Mailroom`;
  - `tabs()` lists two tabs after a second `newTab`;
  - a navigation that redirects ends on the final URL;
  - Review Focus 5: after `Target.closeTarget` mid-navigation, `navigate` rejects with `tab closed`, and `newTab` still works.
- [ ] Implement, with the fixture pages as small, realistic HTML: the mail list with a compose form, a sign-in form with password and OTP fields, a shop with a "Place order" button, a 10,000-row list, a same-origin iframe with a button, and a shadow-DOM component with a button.
- [ ] Tests pass, then commit: `feat(perchd): browser, tabs and fixture pages`.

### Task 3: Secrets

**Files:** `src/page/secrets.ts`, `test/secrets.test.ts`

**Interfaces:** `isSecretField(attrs: Record<string, string>): boolean` and `REDACTED = "••••"`.

- [ ] Write failing tests: password, `autocomplete=cc-number`, `cc-csc`, `one-time-code`, `current-password` and `new-password` are secret; `text`, `email` and `search` are not; the checks ignore case.
- [ ] Implement, pass, commit: `feat(perchd): secret field rules`.

### Task 4: Page snapshot

**Files:** `src/page/snapshot.ts`, `src/page/refs.ts`, `test/snapshot.test.ts`

**Interfaces:**
- Consumes: `Tab`, `isSecretField`.
- Produces:
  - `snapshot(tab: Tab, opts?: { budget?: number; full?: boolean }) → Snapshot`.
  - `Snapshot = { text: string; refs: RefTable; omitted: number }`.
  - `RefTable.resolve(ref: string) → { backendNodeId: number; frameId: string }`, which throws `RefGone`.

Format, one node per line and indented by depth:
- `- role "name" [ref=e12]` for interactive nodes;
- `- heading "Inbox" [level=1]`;
- `- text "…"` for visible text runs;
- `- textbox "To" [ref=e4] value="maya@…"`, with secrets as `value="••••"`;
- `- … 9,940 more rows` when the budget cuts a list.

Interactive roles: button, link, textbox, searchbox, combobox, checkbox, radio, switch, menuitem, tab, option, slider, spinbutton. By default only nodes inside or near the viewport (one screen above and below) are listed, and `full: true` lists all. The default budget is 12,000 characters. Text runs are trimmed to 160 characters.

- [ ] Write failing tests:
  - `mail.html` lists the "Compose" button with a ref and the subject links;
  - `form.html` shows the password field as `value="••••"` after typing into it with `Input.insertText`;
  - Review Focus 2: `long.html` stays under 12,000 characters with an `… N more` line, in under 1,500 ms;
  - Review Focus 3: the iframe and shadow-DOM buttons have refs;
  - the same page snapshotted twice gives the same refs.
- [ ] Implement, pass, commit: `feat(perchd): compact page snapshots with refs`.

### Task 5: Actions

**Files:** `src/page/actions.ts`, `test/actions.test.ts`

**Interfaces:**
- Consumes: `Tab`, `RefTable`.
- Produces:
  - `click(tab, refs, ref)`, `type(tab, refs, ref, text, { submit?: boolean })`, `select(tab, refs, ref, value)`, `press(tab, key)`, `scroll(tab, { ref?, dy })`, `hover(tab, refs, ref)`, `upload(tab, refs, ref, paths)`, `waitFor(tab, { text?: string; ref?: string; timeoutMs })` and `back(tab)`.
  - Every action returns `ActionResult = { ok: true; note: string } | { ok: false; error: string }`.

Click scrolls the node into view, takes the centre of its content box, checks with `DOM.getNodeForLocation` that the node (or a descendant) is the one hit there, and dispatches mouse pressed and released. An element covered by something else fails with `covered by <role "name">`.

- [ ] Write failing tests:
  - clicking "Compose" opens the form;
  - typing into To and Subject sets the values;
  - `select` on a `<select>` changes it and fires `change`;
  - `press Enter` in the search box submits;
  - `upload` puts a file name into the file input;
  - Review Focus 1: after the page replaces the list, clicking an old ref returns `ref e12 is gone; take a new snapshot`;
  - clicking a button under a modal overlay returns a `covered by` error.
- [ ] Implement, pass, commit: `feat(perchd): input actions with stale and covered checks`.

### Task 6: Screenshots and the REPL

**Files:** `src/page/screenshot.ts`, `src/page/repl.ts`, `test/screenshot.test.ts`, `test/repl.test.ts`

**Interfaces:**
- `screenshot(tab, { maxWidth?: number }) → { jpegBase64: string; width: number; height: number }`. Secret fields are covered with solid boxes for the capture and the boxes are removed afterwards.
- `clickAt(tab, x, y)` and `typeText(tab, text)` for canvas-heavy pages.
- `repl(tab, code: string) → { result: unknown; error?: string }`. It runs in an isolated world named `perch-repl`, where reading `.value` of a secret field throws `secret field`.

- [ ] Write failing tests:
  - a screenshot of `form.html` after filling the password has the masking box in the pixels at the field's centre (decode the JPEG with `Bun`'s image support or compare to a known fill colour);
  - `repl("document.title")` returns `Sign in`;
  - `repl` reading the password `.value` returns the error `secret field`;
  - `clickAt` on the centre of a button triggers it.
- [ ] Implement, pass, commit: `feat(perchd): masked screenshots and guarded REPL`.

### Task 7: Permissions and the audit log

**Files:** `src/agent/permissions.ts`, `src/agent/audit.ts`, `test/permissions.test.ts`

**Interfaces:**
- `type Mode = "ask" | "guard" | "skip"`.
- `classify(action: ToolCall, target?: { role: string; name: string; formHasSecret?: boolean }, site: string) → "read" | "change" | "risky" | "payment"`.
- `needsApproval(mode, kind, siteRule?: "allow" | "ask" | "never") → "run" | "ask" | "block"`.
- `class AuditLog { constructor(path: string); append(entry: AuditEntry): Promise<void> }`.

Rules:
- Read: navigate, snapshot, screenshot, scroll, hover, wait and back.
- Change: click, type, select and press, unless they are risky or a payment.
- Risky: a click or Enter whose target name matches `/\b(send|post|publish|submit|delete|remove|share|invite|transfer|confirm|sign up|change password)\b/i`, and any upload.
- Payment: a target name matching `/\b(pay|buy|place order|purchase|checkout|subscribe|book now|confirm payment)\b/i`, or a name with a currency amount.
- Modes: Ask asks for change, risky and payment. Guard asks for risky and payment. Skip asks only for payment. A site rule `never` blocks everything but read; `ask` asks for everything but read; `allow` runs change and risky but still asks for payment.

- [ ] Write a failing table test with at least 24 rows covering every mode × kind and each site rule, plus "Send message" being risky, "Pay $42.18" being a payment, and "Next" being a change. Also test that the audit log appends valid JSON lines that a fresh reader parses.
- [ ] Implement, pass, commit: `feat(perchd): permission modes, risk rules and audit log`.

### Task 8: Model adapters

**Files:** `src/models/types.ts`, `src/models/responses.ts`, `src/models/anthropic.ts`, `src/models/fake.ts`, `test/models.test.ts`, `test/fixtures/sse/*.txt`

**Interfaces:**
- `interface Model { id: string; turn(req: TurnRequest, signal: AbortSignal): AsyncIterable<TurnEvent> }`.
- `TurnRequest = { system: string; messages: Message[]; tools: ToolSpec[]; effort?: "low" | "medium" | "high" }`.
- `TurnEvent = { type: "text"; delta: string } | { type: "tool_call"; id: string; name: string; args: unknown } | { type: "done"; usage?: { input: number; output: number } }`.
- `responsesModel({ provider: "codex" | "grok"; model: string; getToken: () => Promise<Tokens> }, fetch?)`.
- `anthropicModel({ model: string; apiKey: () => Promise<string> }, fetch?)`.
- `fakeModel(script: TurnEvent[][])`.

Codex requests: `Authorization: Bearer`, `originator: codex_cli_rs`, `chatgpt-account-id` when set, `instructions` holding the system prompt, `store: false` and `stream: true`. Grok follows Flint's shape. Anthropic uses `/v1/messages` with `x-api-key`, `anthropic-version: 2023-06-01` and streaming.

- [ ] Write failing tests from recorded SSE fixture files (hand-written in each API's documented event format): text deltas join; a function call with JSON args becomes one `tool_call`; a 400 about effort is retried without effort; an HTTP 401 raises `sign in again` without echoing the token; the request body for Codex matches the expected JSON.
- [ ] Implement, pass, commit: `feat(perchd): Responses and Anthropic model adapters`.

### Task 9: Tools

**Files:** `src/agent/tools.ts`, `test/tools.test.ts`

**Interfaces:**
- `TOOL_SPECS: ToolSpec[]` for `navigate`, `snapshot`, `click`, `type`, `select`, `press`, `scroll`, `hover`, `upload`, `wait_for`, `back`, `screenshot`, `click_at`, `repl`, `tabs`, `open_tab`, `switch_tab` and `done`.
- `runTool(ctx: ToolContext, call: ToolCall) → ToolResult`.
- `ToolResult = { content: string; image?: string }`.

Descriptions are short and identical for every model.

- [ ] Write failing tests: every spec is valid JSON Schema with `additionalProperties: false`; an unknown tool returns `unknown tool "foo"`; missing args return `missing argument "ref"` (Review Focus 4); `click` on the fixture returns a note and a fresh snapshot diff summary.
- [ ] Implement, pass, commit: `feat(perchd): model-agnostic browser tools`.

### Task 10: The agent loop and dev CLI

**Files:** `src/agent/loop.ts`, `src/cli.ts`, `test/loop.test.ts`, `README.md`

**Interfaces:**
- `runTask(opts: { model: Model; browser: Browser; task: string; mode: Mode; approve: (req: ApprovalRequest) => Promise<boolean>; audit: AuditLog; maxSteps?: number }) → AsyncIterable<StepEvent>`.
- `StepEvent = { type: "step"; label: string } | { type: "approval"; request } | { type: "text"; delta } | { type: "final"; text } | { type: "error"; message }`.

Context: the system prompt, then the task, then a rolling window where only the latest snapshot is kept in full and older ones collapse to one line each (`[snapshot of mailroom.app/inbox, 212 lines]`). The default is 40 steps. The loop works in background tabs and never activates them.

- [ ] Write failing tests with `fakeModel`:
  - a scripted run opens `mail.html`, clicks Compose, types and clicks Send, and ends with an approval request for "Send" in Guard mode;
  - denying the approval sends `the user declined` back to the model;
  - a bad tool call is reported back and the loop continues (Review Focus 4);
  - the loop stops at `maxSteps` with a clear message;
  - old snapshots are collapsed in the request the model sees.
- [ ] Implement `cli.ts`: `bun run src/cli.ts run --model fake|codex|grok|anthropic "<task>"` prints step lines. Real models need tokens from a sign-in flow that plan 4 adds, so the CLI says so and exits if none are configured.
- [ ] Tests pass, then commit: `feat(perchd): task loop and dev CLI`.

## Spec coverage

| Spec | Task |
|---|---|
| 7.1 perchd, CDP over a private pipe | 1, 2 |
| 7.2 snapshot with refs, actions, screenshot fallback, REPL, background agent tabs | 4, 5, 6, 10 |
| 7.2 the model never sees a secret | 3, 4, 6 |
| 7.3 Codex and Grok via shared-ai-auth tokens, Claude API key | 8 (Claude Code headless arrives with the MCP server in plan 4) |
| 7.4 modes, payments always ask, site rules, audit log, approval shows what happens | 7, 10 |
| Owner priority 2, most models | 8, 9 (one tool set for every model) |
