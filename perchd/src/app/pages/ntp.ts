/** The new tab page and Welcome: layout, recent chats, setup suggestions and onboarding. */

import { EFFORTS, fitEffort } from "../effort";
import type { ChatSummary, Composer, NtpSection, OnboardingStep, PermissionMode, Suggestion } from "../../../../ui-pages/src/api";
import { isProviderId } from "../../models/ids";
import { aboveCap, capMode } from "../../policy/policy";
import { managed, policyOf } from "./common";
import type { Chat } from "../protocol";
import * as v from "../validate";
import type { Methods } from "./common";
import type { PagesDeps } from "./deps";

const SECTIONS: readonly NtpSection[] = ["recent", "suggested"];
const MODES: readonly PermissionMode[] = ["ask", "guard", "skip"];
const STEPS: readonly OnboardingStep[] = ["appearance", "models", "import", "memory"];
const MAX_CHATS = 200;
const SHOWN_SUGGESTIONS = 3;

const SETUP: readonly (Suggestion & { readonly needed: (s: Setup) => boolean })[] = [
  {
    id: "setup-import", kind: "setup", title: "Bring in your browser data", detail: "Bookmarks, history and passwords from the browser you used before.",
    icon: "import", action: { type: "open", page: "import" }, needed: (s) => !s.imported,
  },
  {
    id: "setup-memory", kind: "setup", title: "Set up your memory", detail: "Perch drafts what it should know about you, and you check it before anything is saved.",
    icon: "memory", action: { type: "open", page: "memory" }, needed: (s) => s.memoryPages === 0,
  },
  {
    id: "setup-routines", kind: "setup", title: "Make a routine", detail: "A task Perch runs for you on a schedule, like a morning summary of your inbox.",
    icon: "routines", action: { type: "open", page: "routines" }, needed: (s) => s.routines === 0,
  },
];

type Setup = { imported: boolean; memoryPages: number | null; routines: number | null };

function summary(deps: PagesDeps, chat: Chat): ChatSummary {
  const s = deps.runs.summary(chat);
  return { id: s.id, title: s.title, snippet: s.preview, updatedAt: s.updatedAt, status: s.status, ...(s.pinned ? { pinned: true } : {}), ...(s.unread ? { unread: true } : {}), ...(s.failed ? { failed: true } : {}) };
}

function layoutPatch(value: unknown) {
  const o = v.object(value, '"patch"');
  v.onlyKeys(o, ["railOpen", "hidden", "recentTab"]);
  return {
    ...(o.railOpen === undefined ? {} : { railOpen: v.bool(o.railOpen, "railOpen") }),
    ...(o.hidden === undefined ? {} : { hidden: [...new Set(v.list(o.hidden, "hidden", SECTIONS.length).map((x) => v.oneOf(x, "hidden", SECTIONS)))] }),
    ...(o.recentTab === undefined ? {} : { recentTab: v.oneOf(o.recentTab, "recentTab", ["chats", "routines"] as const) }),
  };
}

export function ntpPages(deps: PagesDeps): Methods<
  | "getNtpLayout" | "setNtpLayout" | "listChats" | "searchChats" | "listSuggestions" | "dismissSuggestion"
  | "getOnboarding" | "completeOnboardingStep" | "finishOnboarding" | "getComposer" | "setComposer"
> {
  /** The composer under the new tab page's Ask box: the app's models and what the next task starts with. */
  async function composer(): Promise<Composer> {
    const s = await deps.state.get();
    const info = deps.chatInfo?.();
    const models = info?.models ?? [];
    const model = models.some((m) => m.id === s.chatModel) ? s.chatModel! : info?.defaults.model ?? models[0]?.id ?? "";
    const wanted = s.chatEffort ?? info?.defaults.effort ?? "medium";
    return { models, model, effort: fitEffort(models.find((m) => m.id === model)?.efforts, wanted), mode: capMode(s.mode, policyOf(deps)) };
  }
  /** Settings → Models' Default model follows the pick, when it is a model the registry knows. */
  async function noteDefault(model: string) {
    const at = model.indexOf(":");
    const provider = model.slice(0, at);
    if (at <= 0 || !isProviderId(provider)) return;
    await deps.models.registry().then((r) => r.noteUsed({ provider, model: model.slice(at + 1) })).catch(() => undefined);
  }
  async function setup(): Promise<Setup> {
    const { imported } = await deps.state.get();
    const data = await deps.data().catch(() => null);
    return { imported, memoryPages: data ? data.memory.list().length : null, routines: data ? data.routines.list().length : null };
  }

  return {
    getComposer: () => composer(),
    async setComposer([patch]) {
      const o = v.object(patch, '"patch"');
      v.onlyKeys(o, ["model", "effort", "mode"]);
      const models = deps.chatInfo?.().models ?? [];
      const model = o.model === undefined ? undefined : v.oneOf(o.model, "model", models.map((m) => m.id));
      const effort = o.effort === undefined ? undefined : v.oneOf(o.effort, "effort", EFFORTS);
      const mode = o.mode === undefined ? undefined : v.oneOf(o.mode, "mode", MODES);
      if (mode && aboveCap(mode, policyOf(deps))) managed();
      await deps.state.update((s) => ({ ...s, ...(model ? { chatModel: model } : {}), ...(effort ? { chatEffort: effort } : {}), ...(mode ? { mode } : {}) }));
      deps.setDefaults?.({ ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(mode ? { mode } : {}) });
      if (model) await noteDefault(model);
      return composer();
    },
    async getNtpLayout() {
      return (await deps.state.get()).layout;
    },
    async setNtpLayout([patch]) {
      const clean = layoutPatch(patch);
      return (await deps.state.update((s) => ({ ...s, layout: { ...s.layout, ...clean } }))).layout;
    },
    async listChats([limit]) {
      const n = v.integer(limit, "limit", 0, MAX_CHATS);
      return deps.chats.list().slice(0, n).map((c) => summary(deps, c));
    },
    async searchChats([query]) {
      const q = v.text(query, "text", 500).trim().toLowerCase();
      const all = deps.chats.list();
      const found = q ? all.filter((c) => [c.title, ...c.messages.map((m) => m.text)].some((t) => t.toLowerCase().includes(q))) : all;
      return found.slice(0, MAX_CHATS).map((c) => summary(deps, c));
    },
    async listSuggestions() {
      const s = await setup();
      const { dismissed } = await deps.state.get();
      return SETUP.filter((x) => x.needed(s) && !dismissed.includes(x.id))
        .slice(0, SHOWN_SUGGESTIONS)
        .map(({ needed: _, ...card }) => card);
    },
    async dismissSuggestion([id]) {
      const clean = v.id(id, "id");
      await deps.state.update((s) => (s.dismissed.includes(clean) ? s : { ...s, dismissed: [...s.dismissed, clean].slice(-100) }));
    },
    async getOnboarding() {
      return (await deps.state.get()).onboarding;
    },
    async completeOnboardingStep([step]) {
      const clean = v.oneOf(step, "step", STEPS);
      const next = await deps.state.update((s) => (s.onboarding.done.includes(clean) ? s : { ...s, onboarding: { ...s.onboarding, done: [...s.onboarding.done, clean] } }));
      return next.onboarding;
    },
    async finishOnboarding() {
      return (await deps.state.update((s) => ({ ...s, onboarding: { ...s.onboarding, finished: true } }))).onboarding;
    },
  };
}
