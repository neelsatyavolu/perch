import type preact from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ChatSummary } from "../../api";
import { useAction, useApi } from "../../ui/frame";
import { PerchMark } from "../../ui/PerchMark";
import "./tour.css";

/**
 * perch://tour, right after setup. First what setup started (memory, when it was asked for) and
 * the one-click agent setup, then Perch's own parts, each tried for real: chats start beside this
 * page in the side chat, and a step ticks itself off when Perch sees it happen.
 * #memory: the person asked at setup for memory from what they imported.
 */

type StepId = "chat" | "agent" | "bar" | "browser";
const ORDER: readonly StepId[] = ["chat", "agent", "bar", "browser"];
const POLL_MS = 2000;
const STORE = "perch.tour.done";

const CHAT_TRY = "What can you do in Perch? Answer in five short points.";
const FORM_URL = "https://httpbin.org/forms/post";
/** Hands-on work in a real page that anyone can try, signed in or not: a public demo form, filled from memory and left unsent. */
const AGENT_TRY = "Open https://httpbin.org/forms/post and fill in a pizza order for me: my name, phone and email from what you know about me (leave a field empty if you don't know it), a large pizza with mushrooms and onion, delivery at 7:30pm. Don't submit it; show me the filled form.";

function Keys({ keys }: { readonly keys: string }) {
  return <span class="tr-keys">{[...keys].map((k, i) => <kbd key={i}>{k}</kbd>)}</span>;
}

function loadDone(): Set<StepId> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORE) ?? "[]");
    return new Set(Array.isArray(raw) ? (raw as StepId[]) : []);
  } catch {
    return new Set();
  }
}

function saveDone(done: ReadonlySet<StepId>): void {
  try {
    localStorage.setItem(STORE, JSON.stringify([...done]));
  } catch {
    // Only a convenience: without storage the tour starts over next time.
  }
}

/** The recent chats, polled, so a chat that moved on (or finished) shows a step happened. */
function useRecentChats(): readonly ChatSummary[] {
  const api = useApi();
  const [chats, setChats] = useState<readonly ChatSummary[]>([]);
  useEffect(() => {
    let live = true;
    const poll = async () => {
      const list = await api.listChats(10).catch(() => null);
      if (live && list) setChats(list);
    };
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api]);
  return chats;
}

/**
 * A chat step's ask: when its button was pressed, the chats already busy then (Build my memory runs
 * for a long while, and may wait on an approval), and once seen, the chat the ask went to.
 */
type Asked = { readonly at: number; readonly busy: ReadonlySet<string>; readonly chatId?: string; readonly failed?: true };

/** The chat an ask went to: the first one, not busy when asked, that moved after it. */
function chatFor(chats: readonly ChatSummary[], asked: Asked): ChatSummary | undefined {
  if (asked.chatId) return chats.find((c) => c.id === asked.chatId);
  return chats.find((c) => !asked.busy.has(c.id) && Date.parse(c.updatedAt) >= asked.at);
}

type Step = { readonly title: string; readonly body: preact.ComponentChildren; readonly action?: preact.ComponentChildren; readonly next?: string };

export function TourPage() {
  const api = useApi();
  const act = useAction();
  // #memory: setup started Build my memory in a tab of its own.
  const [memoryBuilding] = useState(() => window.location.hash === "#memory");
  // #memory-ready: what came over from Aside already covered it, so nothing is being built.
  const [memoryReady] = useState(() => window.location.hash === "#memory-ready");
  const [memoryFailed] = useState(() => window.location.hash === "#memory-failed");
  const order = ORDER;
  const [done, setDone] = useState<ReadonlySet<StepId>>(loadDone);
  const [open, setOpen] = useState<StepId>(() => order.find((s) => !loadDone().has(s)) ?? order[0]!);
  // When each chat step's button was pressed, and the chats already running then (Build my memory
  // runs for a long while): activity in any other chat after it ticks the step off.
  const [asked, setAsked] = useState<Partial<Record<"chat" | "agent", Asked>>>({});
  const chats = useRecentChats();
  const [shown, setShown] = useState(false);

  const complete = (id: StepId, advance = true) => {
    setDone((d) => {
      if (d.has(id)) return d;
      const next = new Set(d).add(id);
      saveDone(next);
      return next;
    });
    const after = order[order.indexOf(id) + 1];
    if (advance && after) {
      setOpen((o) => (o === id ? after : o));
      // The finished step's button goes away with its body; focus moves to the next step.
      requestAnimationFrame(() => document.getElementById(`tr-head-${after}`)?.focus());
    }
  };

  useEffect(() => {
    for (const step of ["chat", "agent"] as const) {
      const a = asked[step];
      if (!a || a.failed || done.has(step)) continue;
      const chat = chatFor(chats, a);
      if (!chat) continue;
      if (!a.chatId) setAsked((all) => ({ ...all, [step]: { ...a, chatId: chat.id } }));
      if (chat.status !== "idle") continue;
      // A run that errored or was stopped leaves the step open, to try again.
      if (chat.failed) {
        setAsked((all) => ({ ...all, [step]: { ...a, chatId: chat.id, failed: true } }));
        continue;
      }
      complete(step);
      // The form task: come back here (the person may be watching the agent's tab); the step then
      // offers the filled form.
      if (step === "agent" && !shown) {
        setShown(true);
        void api.showThisTab().catch(() => undefined);
      }
    }
  }, [chats]);

  // Both asks go to this tab's side chat, which takes one at a time.
  const answering = (["chat", "agent"] as const).some((s) => {
    const a = asked[s];
    const chat = a && !a.failed ? chatFor(chats, a) : undefined;
    return chat !== undefined && chat.status !== "idle";
  });

  const ask = async (step: "chat" | "agent", text: string) => {
    if (answering || (asked[step] && !asked[step]!.failed)) return;
    const busy = new Set(chats.filter((c) => c.status !== "idle").map((c) => c.id));
    setAsked((a) => ({ ...a, [step]: { at: Date.now(), busy } }));
    await act(() => api.submitQuery({ text, mode: "ask", engine: "brave" }));
  };

  /** The button for a chat step, held while the side chat answers, with word if it failed. */
  const askButton = (step: "chat" | "agent", text: string, label: string) => {
    const a = asked[step];
    const pending = Boolean(a && !a.failed && !done.has(step));
    return (
      <>
        <button type="button" class="btn primary" disabled={answering || pending} onClick={() => ask(step, text)}>{label}</button>
        {a?.failed && <span class="cap" role="status">That didn't finish. Try again.</span>}
        {!a && answering && <span class="cap" role="status">Wait for the side chat to finish its answer.</span>}
      </>
    );
  };

  const steps: Record<StepId, Step> = {
    chat: {
      title: "Ask the side chat",
      body: (
        <>
          <p>The side chat sits next to whatever page you're on and can read it. Open it with <Keys keys="⇧⌘." /> or the Ask Perch button at the end of the toolbar.</p>
          <p class="cap">It runs on the model you connected. Ask it something now; the answer comes in on the right.</p>
        </>
      ),
      action: askButton("chat", CHAT_TRY, "Ask “What can you do?”"),
    },
    agent: {
      title: "Hand it a task",
      body: (
        <>
          <p>Unlike a chatbot, Perch's agent uses real pages: it types, picks, clicks and fills in forms, on the sites you're signed in to and with what it remembers about you. It works in tabs of its own, out of your way; the Agent Tabs button at the end of the tab strip lists them, and you can click one to watch or take over.</p>
          <p class="cap">Try it on a sample order form. It's told not to submit, and in Guard it asks before it sends, posts, buys or deletes anything.</p>
        </>
      ),
      action: shown
        ? <button type="button" class="btn primary" onClick={() => act(() => api.showAgentTab(FORM_URL))}>See the filled form</button>
        : askButton("agent", AGENT_TRY, "Have it fill in an order form"),
    },
    bar: {
      title: "Find anything with the command bar",
      body: <p><Keys keys="⌘K" /> searches your open tabs, history and bookmarks together, and runs commands like New Space or Sleep Tab. Type a few letters of anything you had open.</p>,
      action: <button type="button" class="btn primary" onClick={async () => { await act(() => api.openCommandBar()); complete("bar"); }}>Open the command bar</button>,
    },
    browser: {
      title: "The rest of the browser",
      body: (
        <ul class="tr-keylist">
          <li><span>Ask Perch from the address bar</span><Keys keys="⌘↵" /></li>
          <li><span>Switch spaces, each with its own tabs</span><Keys keys="⌃1" /></li>
          <li><span>Put two tabs side by side</span><Keys keys="⌃⌘N" /></li>
          <li><span>Put a tab to sleep to free memory</span><Keys keys="⌥⇧S" /></li>
          <li><span>Hide the toolbar and tabs</span><Keys keys="⇧⌘\" /></li>
          <li><span>Read, edit or delete what Perch remembers</span><span class="cap">perch://memory</span></li>
          <li><span>Watch together on streaming sites</span><span class="cap">Tab menu, Start Watch Party</span></li>
        </ul>
      ),
      next: "Got it",
    },
  };

  // Finished or skipped, the tour stops opening when Perch starts.
  const leave = async () => {
    await act(() => api.finishTour());
    await act(() => api.openPage("newtab"));
  };
  // Someone who took the whole tour before Perch kept track of it isn't shown it again.
  useEffect(() => {
    if (ORDER.every((s) => loadDone().has(s))) void leave();
  }, []);

  const count = order.filter((s) => done.has(s)).length;
  const all = count === order.length;
  return (
    <main class="tr-page">
      <div class="tr-wrap">
        <header class="tr-top">
          <PerchMark size={22} />
          <h1 tabIndex={-1}>Get to know Perch</h1>
          <span class="cap tr-count" aria-live="polite">{count} of {order.length} done</span>
        </header>
        <p class="tr-lead">Four short steps, each one you try for real. Chats you start here open in the side chat on the right.</p>
        {memoryFailed && (
          <p class="tr-note" role="status"><span class="dotc" aria-hidden="true" />Build my memory couldn't start. You can start it later from perch://memory.</p>
        )}
        {memoryReady && (
          <p class="tr-note" role="status"><span class="dotc" aria-hidden="true" />Your memory came over from Aside and already covers you well, so Perch didn't build it again. See it at perch://memory.</p>
        )}
        {memoryBuilding && (
          <p class="tr-note" role="status"><span class="dotc" aria-hidden="true" />Perch is building your memory in the “Build my memory” tab. It saves as it goes; look in any time to answer its questions.</p>
        )}
        <ol class="tr-steps">
          {order.map((id, i) => {
            const s = steps[id];
            const isOpen = open === id;
            const isDone = done.has(id);
            return (
              <li key={id} class={`tr-step${isOpen ? " open" : ""}${isDone ? " done" : ""}`}>
                <button type="button" class="tr-head" id={`tr-head-${id}`} aria-expanded={isOpen} aria-controls={`tr-${id}`} onClick={() => setOpen(id)}>
                  <span class="tr-num" aria-hidden="true">{isDone ? "✓" : i + 1}</span>
                  <span class="tr-title">{s.title}</span>
                  {isDone && <span class="sr-only">, done</span>}
                </button>
                {isOpen && (
                  <div class="tr-body" id={`tr-${id}`}>
                    {s.body}
                    {(s.action || s.next) && (
                      <div class="tr-actions">
                        {s.action}
                        {s.next && <button type="button" class={s.action ? "btn quiet" : "btn"} onClick={() => complete(id)}>{s.next}</button>}
                        {isDone && s.action && <span class="status ok"><span class="dotc" />Done</span>}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        <div class="tr-foot">
          <span class="cap">Open this tour again from Settings, under About.</span>
          <span class="grow" />
          <button type="button" class={all ? "btn primary" : "btn"} onClick={leave}>{all ? "Start browsing" : "Skip the rest"}</button>
        </div>
      </div>
    </main>
  );
}
