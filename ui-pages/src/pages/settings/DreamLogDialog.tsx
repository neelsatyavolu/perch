import type { DreamLog } from "../../api";
import { shortDateTime } from "../../lib/time";
import { useLoad } from "../../ui/frame";
import { Dialog } from "../../ui/Dialog";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const counts = (d: DreamLog) =>
  [plural(d.merged, "merge", "merges"), plural(d.updated, "fact updated", "facts updated"), plural(d.archived, "moved to History", "moved to History")].join(" · ");

function Entries() {
  const logs = useLoad((a) => a.listDreamLogs(14));
  if (logs.error) return <p class="mute">{logs.error}</p>;
  if (!logs.data) return <p class="mute" aria-busy="true">Loading</p>;
  if (logs.data.length === 0) return <p class="mute">Perch hasn't tidied memory yet. The first pass runs tonight.</p>;
  return (
    <ol class="dream-list">
      {logs.data.map((d) => (
        <li key={d.id}>
          <h3 class="mono">{shortDateTime(d.at)}</h3>
          <p class="cap">{counts(d)}</p>
          <ul>{d.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </li>
      ))}
    </ol>
  );
}

/** What each overnight tidy changed (spec 8: dreaming "writes a dated log the user can read"). */
export function DreamLogDialog({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  return (
    <Dialog open={open} title="Overnight tidy log" onClose={onClose} footer={<button type="button" class="btn primary" onClick={onClose}>Done</button>}>
      {open && <Entries />}
    </Dialog>
  );
}
