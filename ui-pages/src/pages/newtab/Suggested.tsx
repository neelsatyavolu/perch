import type { LucideIcon } from "lucide-preact";
import type { Suggestion, SuggestionIcon } from "../../api";
import { useAction, useApi } from "../../ui/frame";
import { ArrowDownToLine, Calendar, Icon, Mail, MessageSquare, Repeat, User, X } from "../../ui/icons";

const ICONS: Readonly<Record<SuggestionIcon, LucideIcon>> = {
  memory: User, routines: Repeat, import: ArrowDownToLine, mail: Mail, calendar: Calendar, task: MessageSquare,
};

type Props = {
  readonly items: readonly Suggestion[];
  readonly onHide: () => void;
  /** Called after one card was dismissed, so the page can fetch the next suggestion. */
  readonly onDismissed: (id: string) => void;
};

export function Suggested({ items, onHide, onDismissed }: Props) {
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
          <div key={s.id} class="sug-wrap">
            <button type="button" class="ccard sug" onClick={() => run(s)}>
              <span class="tile"><Icon of={ICONS[s.icon]} size={14} /></span>
              <span class="tt">{s.title}</span>
              <span class="sn">{s.detail}</span>
            </button>
            <button type="button" class="ib sug-x" aria-label={`Dismiss ${s.title}`}
              onClick={async () => { if (await act(() => api.dismissSuggestion(s.id).then(() => true))) onDismissed(s.id); }}>
              <Icon of={X} size={14} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
