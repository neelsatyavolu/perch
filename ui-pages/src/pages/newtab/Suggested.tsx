import type { LucideIcon } from "lucide-preact";
import type { Suggestion, SuggestionIcon } from "../../api";
import { useAction, useApi } from "../../ui/frame";
import { ArrowDownToLine, Calendar, Icon, Mail, MessageSquare, Repeat, User } from "../../ui/icons";

const ICONS: Readonly<Record<SuggestionIcon, LucideIcon>> = {
  memory: User, routines: Repeat, import: ArrowDownToLine, mail: Mail, calendar: Calendar, task: MessageSquare,
};

export function Suggested({ items, onHide }: { readonly items: readonly Suggestion[]; readonly onHide: () => void }) {
  const api = useApi();
  const act = useAction();
  if (items.length === 0) return null;
  const run = (s: Suggestion) =>
    act(() => (s.action.type === "open" ? api.openPage(s.action.page) : api.submitQuery({ text: s.action.prompt, mode: "ask", engine: "brave" })));
  return (
    <section class="ntp-sec" aria-labelledby="sug-h">
      <div class="sec-h">
        <h2 class="sug-h" id="sug-h">Suggested</h2>
        <button type="button" class="btn quiet sm hide-btn" aria-label="Hide suggested" onClick={onHide}>Hide</button>
      </div>
      <div class="cards">
        {items.map((s) => (
          <button type="button" key={s.id} class="ccard sug" onClick={() => run(s)}>
            <span class="tile"><Icon of={ICONS[s.icon]} size={14} /></span>
            <span class="tt">{s.title}</span>
            <span class="sn">{s.detail}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
