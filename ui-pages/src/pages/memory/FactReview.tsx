import { useRef, useState } from "preact/hooks";
import type { DraftFact } from "../../api";
import { FACT_GROUPS } from "../../lib/labels";
import { Icon, Pencil, X } from "../../ui/icons";

type Props = { readonly facts: readonly DraftFact[]; readonly onChange: (facts: readonly DraftFact[]) => void };

/** The review list: facts grouped as About you, People, Places and accounts, Writing style, Sites. */
export function FactReview({ facts, onChange }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const open = useRef<string | null>(null);

  const commit = (id: string) => {
    if (open.current !== id) return;
    open.current = null;
    const clean = text.trim();
    onChange(clean ? facts.map((f) => (f.id === id ? { ...f, text: clean } : f)) : facts.filter((f) => f.id !== id));
    setEditing(null);
  };

  return (
    <div class="facts">
      {FACT_GROUPS.map((g) => {
        const items = facts.filter((f) => f.group === g.id);
        if (items.length === 0) return null;
        return (
          <section key={g.id} aria-labelledby={`fg-${g.id}`}>
            <h3 class="fact-g" id={`fg-${g.id}`}>{g.label}</h3>
            <ul class="fact-list">
              {items.map((f) => (
                <li key={f.id} class="fact">
                  {editing === f.id ? (
                    <input
                      class="field"
                      aria-label="Edit fact"
                      value={text}
                      ref={(el) => el?.focus()}
                      onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commit(f.id);
                        if (e.key === "Escape") {
                          open.current = null;
                          setEditing(null);
                        }
                      }}
                      onBlur={() => commit(f.id)}
                    />
                  ) : (
                    <span class="fact-text">{f.text}</span>
                  )}
                  <span class="src-tag">{f.source}</span>
                  <span class="fact-act">
                    <button type="button" class="ib sm" aria-label={`Edit “${f.text}”`} onClick={() => { setText(f.text); open.current = f.id; setEditing(f.id); }}>
                      <Icon of={Pencil} size={14} />
                    </button>
                    <button type="button" class="ib sm" aria-label={`Remove “${f.text}”`} onClick={() => onChange(facts.filter((x) => x.id !== f.id))}>
                      <Icon of={X} size={14} />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
