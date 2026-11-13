/**
 * "Set up your memory": the fast model drafts facts from the chosen sources as a job, the draft
 * waits in perchd until the person saves or discards it, and only "Save to memory" files anything
 * (src/memory/setup.ts). Sources that need an export file have none yet, so `files` is not used.
 */

import type { DraftFact, FactGroup, SetupSource } from "../../../../ui-pages/src/api";
import { MAX_FACT } from "../../memory/sanitize";
import { addItem, DEFAULT_SOURCES, editItem, GROUPS, removeItem, saveProfile, SOURCES, type ProfileDraft, type SourceId } from "../../memory/setup";
import { AppError } from "../runs";
import * as v from "../validate";
import { ok, plainly, type Methods } from "./common";
import type { PagesDeps } from "./deps";

/** The questionnaire needs answers the page has no form for, so it is not offered here. */
const OFFERED = SOURCES.filter((s) => s.id !== "questionnaire" && s.id !== "research");
const GROUP_IDS = GROUPS.map((g) => g.id) as readonly FactGroup[];
const MAX_FACTS = 500;

const sourceLabel = (ids: readonly SourceId[]) => ids.map((id) => SOURCES.find((s) => s.id === id)?.label ?? id).join(", ");

function factsInput(value: unknown): DraftFact[] {
  return v.list(value, "facts", MAX_FACTS).map((item, i) => {
    const o = v.object(item, `"facts[${i}]"`);
    v.onlyKeys(o, ["id", "group", "text", "source"]);
    return { id: v.id(o.id, "id"), group: v.oneOf(o.group, "group", GROUP_IDS), text: v.text(o.text, "text", MAX_FACT).trim(), source: v.text(o.source ?? "", "source", 200) };
  });
}

/** The draft as the person left it: removed facts dropped, edited ones changed, new ones added. */
function finalDraft(draft: ProfileDraft, facts: readonly DraftFact[]): ProfileDraft {
  const wanted = new Map(facts.map((f) => [f.id, f]));
  let next = draft.items.filter((i) => !wanted.has(i.id)).reduce((d, i) => removeItem(d, i.id), draft);
  for (const f of facts) {
    if (!f.text) next = next.items.some((i) => i.id === f.id) ? removeItem(next, f.id) : next;
    else if (next.items.some((i) => i.id === f.id)) next = editItem(next, f.id, { group: f.group, text: f.text });
    else next = addItem(next, { group: f.group, title: "", text: f.text });
  }
  return next;
}

export function profilePages(deps: PagesDeps): Methods<
  "listSetupSources" | "startProfileBuild" | "getProfileBuild" | "getProfileDraft" | "saveProfileDraft" | "discardProfileDraft"
> & { forget(): void } {
  let buildJob: string | null = null;
  // The draft lives with the profile's data, so the agent's memory_propose (Build my memory) fills
  // the same review the Memory page shows.
  const holder = async () => (await deps.data()).profileDraft;

  return {
    forget() {
      void holder().then((h) => (h.current = null)).catch(() => undefined);
    },
    async listSetupSources() {
      return OFFERED.map((s): SetupSource => ({ id: s.id, name: s.label, detail: s.description, on: s.available && DEFAULT_SOURCES[s.id], available: s.available }));
    },
    async startProfileBuild([rawIds, rawFiles]) {
      const ids = [...new Set(v.list(rawIds, "sourceIds", OFFERED.length).map((x, i) => v.oneOf(x, `sourceIds[${i}]`, OFFERED.map((s) => s.id))))];
      if (rawFiles !== undefined && rawFiles !== null) Object.values(v.object(rawFiles, '"files"')).forEach((f) => v.id(f, "files"));
      if (ids.length === 0) throw new AppError("Turn on at least one source");
      const blocked = OFFERED.find((s) => ids.includes(s.id) && !s.available);
      if (blocked) throw new AppError(`${blocked.label} isn't available yet`);
      if (deps.jobs.running(buildJob)) throw new AppError("A build is already running", 409);
      const api = (await deps.data()).memoryApi;
      const sources = Object.fromEntries(ids.map((id) => [id, true]));
      buildJob = deps.jobs.start(1, `Reading ${sourceLabel(ids).toLowerCase()} and drafting facts`, async (job) => {
        const built = ok(await api.startSetup({ sources }));
        (await holder()).current = built;
        job.finish([`${built.items.length} ${built.items.length === 1 ? "fact" : "facts"} to review`]);
      });
      return buildJob;
    },
    async getProfileBuild() {
      return deps.jobs.running(buildJob) ? buildJob : null;
    },
    async getProfileDraft() {
      const draft = (await holder()).current;
      return (draft?.items ?? []).map((i): DraftFact => ({ id: i.id, group: i.group, text: i.text, source: sourceLabel(i.sources.length ? i.sources : draft!.sources) }));
    },
    async saveProfileDraft([rawFacts]) {
      const facts = factsInput(rawFacts);
      const h = await holder();
      const draft = h.current;
      if (!draft) throw new AppError("There's no draft to save. Build one first.", 409);
      const final = await plainly(() => finalDraft(draft, facts));
      const result = await saveProfile((await deps.data()).memory, final);
      h.current = null;
      return { saved: result.added };
    },
    async discardProfileDraft() {
      (await holder()).current = null;
    },
  };
}
