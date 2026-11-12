import { useState } from "preact/hooks";
import type { UpdateStatus } from "../../api";
import { shortDateTime } from "../../lib/time";
import { MANAGED_NOTE } from "../../lib/managed";
import { useAction, useApi, useLoad } from "../../ui/frame";
import { useManaged } from "../../ui/useManaged";
import { PerchMark } from "../../ui/PerchMark";
import { Group, Row } from "../../ui/Row";
import { Switch } from "../../ui/Switch";

function statusWords(s: UpdateStatus | null, lastChecked?: string): string {
  if (!s) return lastChecked ? `Last checked ${shortDateTime(lastChecked)}` : "Not checked yet";
  switch (s.state) {
    case "checking": return "Checking";
    case "up-to-date": return "Perch is up to date";
    case "available": return `Perch ${s.version ?? ""} is available`;
    case "downloading": return `Downloading Perch ${s.version ?? ""}`;
    case "ready": return `Perch ${s.version ?? ""} is ready. Restart to finish.`;
    case "error": return s.message ?? "Couldn't check for updates. Check your connection and try again.";
    default: return "";
  }
}

export function About() {
  const api = useApi();
  const act = useAction();
  const about = useLoad((a) => a.getAbout());
  const { locked, managed } = useManaged();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const a = about.data;
  if (!a) return <p class="mute">{about.error ?? ""}</p>;
  const check = async () => {
    setStatus({ state: "checking" });
    const s = await act(() => api.checkForUpdates());
    setStatus(s ?? { state: "error" });
  };
  return (
    <div class="sec">
      <Group label="Version">
        <div class="card">
          <Row id="version" title={`Perch ${a.version}`} detail={`${a.channel === "beta" ? "Beta" : "Stable"} channel`} icon={<span class="tile" aria-hidden="true"><PerchMark size={32} tile={false} /></span>}>
            <span class="status" role="status">{statusWords(status, a.lastChecked)}</span>
            {status?.state === "available" || status?.state === "ready" ? (
              <button type="button" class="btn primary" onClick={async () => setStatus((await act(() => api.installUpdate())) ?? status)}>
                {status.state === "ready" ? "Restart Perch" : "Install update"}
              </button>
            ) : (
              <button type="button" class="btn" disabled={status?.state === "checking"} onClick={check}>Check for updates</button>
            )}
          </Row>
          <Row id="auto-update" title="Update automatically" detail={locked("auto-update") ? MANAGED_NOTE : "Checks once a day on GitHub and installs signed updates when you restart"}>
            <Switch label="Update automatically" describedBy="auto-update-d" checked={a.autoUpdate} disabled={locked("auto-update")} onChange={async (on) => {
              const next = await act(() => api.setAutoUpdate(on));
              if (next) about.set(next);
            }} />
          </Row>
          {managed && (
            <Row id="managed" title="Your organization manages some settings" detail="See every policy and where it came from">
              <a class="btn" href="perch://policy">Open policies</a>
            </Row>
          )}
        </div>
      </Group>
      <Group label="Components">
        <div class="card">
          <Row title="Chromium" detail="The engine Perch is built on"><span class="chip2">{a.chromium}</span></Row>
          <Row title="perchd" detail="Perch's agent service"><span class="chip2">{a.perchd}</span></Row>
        </div>
        <p class="note">Perch is open source under the MIT licence. Chromium is under the BSD licence.</p>
      </Group>
    </div>
  );
}
