import type { BuiltInName } from "../../api";
import { MANAGED_NOTE } from "../../lib/managed";
import { useAction, useApi, useLoad } from "../../ui/frame";
import { useManaged } from "../../ui/useManaged";
import { Group, Row } from "../../ui/Row";
import { Switch } from "../../ui/Switch";

const ABOUT: Readonly<Record<BuiltInName, { title: string; detail: string }>> = {
  perch: { title: "Perch tools", detail: "Ad and tracker blocking, cookie banners, tracking parameters, reader view, video keys, link preview and screenshots" },
  backrow: { title: "Backrow", detail: "Watch Netflix, YouTube and other services in sync with friends, with an encrypted chat beside the video" },
  caveatly: { title: "Caveatly", detail: "Reads a site's terms of service and privacy policy and grades what they say. Uses your own Gemini API key" },
};

/** The extensions Perch ships built in. They can be turned off here, never removed. */
export function BuiltIn() {
  const api = useApi();
  const act = useAction();
  const list = useLoad((a) => a.listBuiltInExtensions());
  const { locked } = useManaged();
  if (!list.data) return <p class="mute">{list.error ?? ""}</p>;
  const isLocked = (name: BuiltInName) => name === "backrow" && locked("built-in-backrow");
  return (
    <div class="sec">
      <Group label="Built in" id="built-in">
        <div class="card">
          {list.data.map((b) => (
            <Row key={b.name} id={`built-in-${b.name}`} title={ABOUT[b.name].title} detail={isLocked(b.name) ? MANAGED_NOTE : ABOUT[b.name].detail}>
              <Switch
                label={ABOUT[b.name].title}
                describedBy={`built-in-${b.name}-d`}
                checked={b.enabled}
                disabled={isLocked(b.name)}
                onChange={async (v) => {
                  const next = await act(() => api.setBuiltInExtension(b.name, v), `${ABOUT[b.name].title} ${v ? "is on" : "is off"}`);
                  if (next) list.set(next);
                }}
              />
            </Row>
          ))}
        </div>
        <p class="note">They update with Perch and send nothing on their own. Turning one off unloads it right away.</p>
      </Group>
    </div>
  );
}
