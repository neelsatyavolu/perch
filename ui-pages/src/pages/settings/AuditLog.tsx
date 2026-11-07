import { useState } from "preact/hooks";
import type { AuditEntry, AuditExport, AuditFormat } from "../../api";
import { AUDIT_OUTCOMES } from "../../lib/labels";
import { shortDateTime } from "../../lib/time";
import { useAction, useAnnounce, useApi, useLoad } from "../../ui/frame";
import { Group } from "../../ui/Row";

const PAGE = 50;

/** Saves the export with a download link: perchd hands back the file's text, not a path. */
export function download(file: AuditExport): void {
  const url = URL.createObjectURL(new Blob([file.text], { type: file.type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Every agent action (spec 7.4): when, which client, which tab and site, what, and whether it was approved. */
export function AuditLog() {
  const api = useApi();
  const act = useAction();
  const announce = useAnnounce();
  const first = useLoad((a) => a.listAuditLog({ limit: PAGE }));
  const [older, setOlder] = useState<readonly AuditEntry[]>([]);
  const [end, setEnd] = useState(false);
  const entries = [...(first.data ?? []), ...older];
  const more = async () => {
    const last = entries.at(-1);
    if (!last) return;
    const next = await act(() => api.listAuditLog({ limit: PAGE, before: last.at }));
    if (!next) return;
    setOlder((x) => [...x, ...next]);
    if (next.length < PAGE) setEnd(true);
  };
  const exportLog = async (format: AuditFormat) => {
    const r = await act(() => api.exportAuditLog(format));
    if (!r) return;
    download(r);
    announce(`Saved ${r.entries} actions to ${r.name}`);
  };
  const hasMore = !end && (first.data?.length ?? 0) >= PAGE;

  return (
    <Group label="Activity log" id="audit-log">
      <div class="card">
        {first.error && <p class="empty">{first.error}</p>}
        {first.data && entries.length === 0 && <p class="empty">The agent hasn't done anything yet.</p>}
        {entries.length > 0 && (
          <table class="audit">
            <caption class="sr-only">Agent actions, newest first</caption>
            <thead>
              <tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Where</th><th scope="col">What</th><th scope="col">Result</th></tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} class={`o-${e.outcome}`}>
                  <td class="mono">{shortDateTime(e.at)}</td>
                  <td>{e.client}</td>
                  <td><span class="mono">{e.site}</span><span class="tab-t">{e.tab}</span></td>
                  <td>{e.action}</td>
                  <td>{AUDIT_OUTCOMES[e.outcome]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {hasMore && <button type="button" class="more-row" onClick={more}>Show older actions</button>}
      </div>
      <div class="audit-foot">
        <p class="note">Kept on this Mac, encrypted. Routines and outside agents are listed here too.</p>
        <button type="button" class="btn" onClick={() => exportLog("csv")}>Export CSV</button>
        <button type="button" class="btn" onClick={() => exportLog("jsonl")}>Export JSON lines</button>
      </div>
    </Group>
  );
}
