# Perch plan: agent quality (computer use)

**Goal:** make the browser agent better on real sites with general fixes only, never tuned to a benchmark. Every fix comes from a failure seen in the benchmark trajectories and ships with a fixture-page test.

**Spec:** `docs/superpowers/specs/2026-11-02-perch-design.md` sections 7.2 to 7.4. Roadmap: plan 3a (agent core) is the base.

## Evidence

Trajectories in `bench/results/` (git-ignored): `bu-perch-1` (68/100), `om2w-perch-1`, and `retry-1` (the failures run again). The benchmark drives Perch through Claude Code over MCP, so page and tool fixes reach both the MCP path and the native loop (`runTask`).

Bot walls (Cloudflare, DataDome, "press and hold", sign-in walls) cause about a third of the failures. They are out of scope: Perch never solves or evades a CAPTCHA.

Counted across all four runs (about 3,000 tool calls), the general weaknesses are:

| Weakness | Evidence | Fix |
|---|---|---|
| Suggestion fields never open their list | `type` inserts text in one step with no key events; the model fell back to pressing keys one by one (WebMD, Healthgrades, Target careers) | type sends real key events; the result says when suggestions appeared |
| `press " "` is an unknown key | Healthgrades | accept a literal space |
| Hidden radios and checkboxes | "the element is not visible" (17), radios drawn by their labels | click the visible label, or toggle the control itself |
| Clipped elements in scroll boxes | "hidden or clipped on screen" (35) | scroll every scroll container, then retry the click |
| Slow pages fail navigate | "page did not finish loading in 30s" (35) | return the page once its content is there, with a note |
| Actions that change nothing | filters that silently did not apply (StreetEasy, Vrbo) | a note when the page did not change after an action |
| Lazy lists and infinite scroll | WebMD showed 3 of 43 results | scroll waits for new content and says whether the page grew or ended |
| The REPL cannot fetch | "Failed to fetch" (39), relative URLs fail (6) | a plain error that says to open the URL with navigate |
| Wrong argument names | `wait_for {seconds}`, `scroll {direction}`, `switch_tab {tab}` | errors list the arguments the tool takes; `wait_for` can wait a few seconds |
| `done` called over MCP | 45 errors | the outside-agent prompt says to reply instead |
| A ref gone after a re-render | 22 | the error carries the fresh snapshot, so no extra step |
| Long research runs out of time with no answer | 8d92dbe1 (99 steps, 900 s), 3ca72fce | budget notes in tool results, a final best-effort answer in the native loop |
| Repeating the same action | identical calls back to back (31) | a note after the third repeat with ways out |
| No drag | sliders, sortable lists, maps | a `drag` tool (mouse and HTML5 drag and drop) |
| Range sliders | no way to set a value | `type` sets range inputs and ARIA sliders |

## Found while fixing

- The click hit-test used DOM.getNodeForLocation, which takes document coordinates, not viewport ones. On any scrolled page it tested the wrong point, which explains most "hidden or clipped" and many "covered by" errors on real sites. Clicks now hit-test with elementFromPoint in the target's own document.
- Custom suggestion lists, chips and menus are often plain elements with cursor: pointer and a click handler, so they had no ref. The snapshot now gives the outermost such element (with text and nothing interactive inside) a `clickable` ref.

## Aside parity checklist (agent quality)

- [x] Snapshot with refs, iframes, shadow DOM (plan 3a)
- [x] Autocomplete and comboboxes that need key events
- [x] Sliders (native and ARIA)
- [x] Drag and drop
- [x] Lazy lists and infinite scroll
- [x] Hidden native controls behind styled labels
- [x] Partial page loads
- [x] Time and step budget, final answer guarantee, stuck-loop recovery
- [x] Model adapters: effort for Claude, prompt caching, final answer turn with no tools

## File layout

New files keep shared files small:

- `perchd/src/page/typing.ts`: key-by-key typing and suggestion detection
- `perchd/src/page/slider.ts`: native range inputs and ARIA sliders
- `perchd/src/page/drag.ts`: drag from a ref to a ref or by an offset
- `perchd/src/page/pointing.ts`: scrolling into view, hit-testing and hidden-control fallbacks for clicks
- `perchd/src/page/node.ts`: live nodes behind refs, shared by the page actions
- `perchd/src/page/scrolling.ts`: wheel scrolling, lazy-load growth and end of page
- `perchd/src/page/navigation.ts`: returning slow pages once parsed
- `perchd/src/agent/progress.ts`: budget notes and repeated-action notes, shared by `runTask` and the MCP server
- `perchd/src/agent/finish.ts`: the final best-effort answer turn

The note for an action that changed nothing lives in `agent/tools.ts`, next to the dispatch that compares the page before and after.

Shared files touched minimally: `agent/tool-specs.ts` (drag, wait_for seconds, error text), `agent/tools.ts` (dispatch), `mcp.ts` (progress notes), `external.ts` (time budget for MCP, reply prompt).

## Tasks

1. Prompt and tool-schema fixes: reply-not-done for outside agents, argument errors that list the tool's arguments, `wait_for` seconds, REPL network error. Tests: `tools.test.ts`, `loop.test.ts`.
2. Typing with key events, suggestions note, space key. Fixture: `autocomplete.html`.
3. Click fallbacks: hidden native controls, clipped elements. Fixture: `controls.html`.
4. Navigate returns slow pages. Fixture server route that never finishes loading.
5. Change notes and scroll growth. Fixture: `lazy.html` (its Apply button that does nothing stands in for a filter that silently does not apply), tested in `changes.test.ts`.
6. Sliders and drag. Fixture: `drag.html`.
7. Gone refs carry a fresh snapshot.
8. Progress notes (budget and repeats) in `runTask` and MCP; final answer guarantee and time limit in `runTask`.
9. Model adapters: Anthropic effort (`output_config.effort`, dropped if the model refuses it), top-level prompt caching, higher `max_tokens` for adaptive thinking, refusal message, `tool_choice` none for the final turn; Responses `tool_choice` none and high-detail screenshots.

## Deferred

- Custom JavaScript date pickers (calendar widgets): no general fix beyond typing into the field and the change notes; needs real-site study.
- Chart reading beyond screenshots: the prompt points the model at the data behind a chart; a chart-data extractor needs more evidence.
- Recovering a gone ref by matching role and name: plan 3a requires a stale ref never to act on another element, so it stays an error (now with the fresh snapshot).
- Passing Claude thinking blocks back between turns: the loop collapses old snapshots, which edits history, and edited history makes the API reject replayed thinking blocks. The loop keeps dropping them.
- Live benchmark runs: at most a few single tasks to confirm a fix. None was run on this branch, so every fix is proven on fixture pages only.
- Multi-tab research: the tab tools from plan 3a are unchanged; no trajectory showed a tab-specific failure that a general fix would address.
- Hover menus: `hover` exists (plan 3a), but menus that open only on hover and close when the pointer leaves are not handled beyond it.
- Canvas apps: `screenshot` and `click_at` are the only way in; no canvas-specific work.
- Dialogs and iframes: beyond the "close it first" hint on a "covered by" error and the existing iframe and shadow DOM snapshot support, nothing new.
- Live check of the Anthropic adapter on current Claude models: they think by default, and the adapter drops thinking blocks between turns. Dropping every block (never replaying any) should not trip the conversation check, but this has only been run against a fake fetch, never the real API.

## Review fixes

- A drag by pixels lands on an element nobody identified, so outside a slider, scrollbar or splitter it counts as risky (`permissions.test.ts`).
- A checkbox or radio under a dialog or banner is no longer toggled through it; only the page's own drawing of the control (inside its label or parent) is clicked past (`pointing.test.ts`).
- Shifted symbols are typed as their real key with Shift. Their char codes were the key codes of Home, End, PageUp/Down and the arrows, which moved the caret mid-typing ("$5 (a&b)" came out scrambled) and drove suggestion lists (`typing.test.ts`, `keys.html`).
- Time spent waiting for an approval does not count against the task's time budget; a `done` after the time is up is the answer, and a draft answer sent back for checking is kept if the final turn fails (`loop.test.ts`, `progress.test.ts`).
