import { useState } from "preact/hooks";
import type { Skill } from "../../api";
import { checkSkillLocation } from "../../lib/validate";
import { errorText, useAction, useAnnounce, useApi, useLoad } from "../../ui/frame";
import { Dialog } from "../../ui/Dialog";
import { Icon, Plus, Trash2 } from "../../ui/icons";
import { Group, Row } from "../../ui/Row";
import { Segmented } from "../../ui/Segmented";
import { Switch } from "../../ui/Switch";

type Origin = "folder" | "url" | "git";
const PLACEHOLDER: Readonly<Record<Origin, string>> = { folder: "~/skills/pdf", url: "https://example.com/skills/pdf/SKILL.md", git: "https://github.com/you/skills.git" };
const ORIGIN_WORDS: Readonly<Record<Skill["origin"], string>> = { "built-in": "Built in", folder: "From a folder", url: "From a link", git: "From a git repository", aside: "From Aside" };

function AddSkillDialog({ open, onClose, onAdded }: { readonly open: boolean; readonly onClose: () => void; readonly onAdded: (s: Skill) => void }) {
  const api = useApi();
  const [origin, setOrigin] = useState<Origin>("folder");
  const [location, setLocation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setLocation("");
    setError(null);
    onClose();
  };
  const save = async () => {
    const c = checkSkillLocation(origin, location);
    if (!c.ok) return setError(c.error);
    try {
      onAdded(await api.addSkill({ origin, location: c.value }));
      setLocation("");
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Dialog open={open} title="Add a skill" onClose={close} footer={<><button type="button" class="btn" onClick={close}>Cancel</button><button type="button" class="btn primary" onClick={save}>Add skill</button></>}>
      <p class="note">Skills use the SKILL.md format, so the same folder works in Claude Code and Codex.</p>
      <Segmented<Origin> label="Where the skill is" value={origin} onChange={setOrigin} options={[{ value: "folder", label: "Folder" }, { value: "url", label: "Link" }, { value: "git", label: "Git repository" }]} />
      <label class="label">
        <span>{origin === "folder" ? "Folder" : origin === "url" ? "Link" : "Repository"}</span>
        <input class="field mono" spellcheck={false} placeholder={PLACEHOLDER[origin]} value={location} aria-invalid={error ? "true" : undefined} onInput={(e) => setLocation((e.currentTarget as HTMLInputElement).value)} />
      </label>
      {error && <p class="field-error" role="alert">{error}</p>}
    </Dialog>
  );
}

export function SkillsCard() {
  const api = useApi();
  const act = useAction();
  const announce = useAnnounce();
  const skills = useLoad((a) => a.listSkills());
  const [adding, setAdding] = useState(false);
  const [showBuiltIn, setShowBuiltIn] = useState(false);
  const list = skills.data ?? [];
  const builtIn = list.filter((s) => s.origin === "built-in");
  const mine = list.filter((s) => s.origin !== "built-in");
  const replace = (s: Skill) => skills.set(list.map((x) => (x.id === s.id ? s : x)));
  const toggle = async (s: Skill, enabled: boolean) => {
    const next = await act(() => api.setSkillEnabled(s.id, enabled));
    if (next) replace(next);
  };

  return (
    <Group label="Skills" id="skills-list">
      <div class="card">
        <Row title="Built-in site skills" detail={`Mail, calendar, docs, GitHub, Slack and more. ${builtIn.filter((s) => s.enabled).length} of ${builtIn.length} on`}>
          <button type="button" class="btn" aria-expanded={showBuiltIn ? "true" : "false"} onClick={() => setShowBuiltIn((x) => !x)}>
            {showBuiltIn ? "Hide list" : "Show list"}
          </button>
        </Row>
        {showBuiltIn && builtIn.map((s) => (
          <Row key={s.id} sub title={s.name} detail={s.description}>
            <Switch label={`Use the ${s.name} skill`} checked={s.enabled} onChange={(v) => toggle(s, v)} />
          </Row>
        ))}
        {mine.map((s) => (
          <Row key={s.id} title={s.name} detail={`${ORIGIN_WORDS[s.origin]}${s.location ? ` · ${s.location}` : ""}`}>
            <button type="button" class="ib" aria-label={`Remove ${s.name}`} onClick={async () => {
              if (await act(() => api.removeSkill(s.id).then(() => true), `Removed ${s.name}`)) skills.set(list.filter((x) => x.id !== s.id));
            }}><Icon of={Trash2} /></button>
            <Switch label={`Use the ${s.name} skill`} checked={s.enabled} onChange={(v) => toggle(s, v)} />
          </Row>
        ))}
        <button type="button" class="more-row" onClick={() => setAdding(true)}><Icon of={Plus} />Add a skill from a folder, link or git repository</button>
      </div>
      <AddSkillDialog open={adding} onClose={() => setAdding(false)} onAdded={(s) => {
        setAdding(false);
        skills.set([...list, s]);
        announce(`Added ${s.name}`);
      }} />
    </Group>
  );
}
