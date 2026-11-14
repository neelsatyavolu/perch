/**
 * Settings › Profile: this profile's name and icon, as Aside lets you set them. The icon shows in
 * the chevron at the end of the tab strip and beside the profile in its menu.
 */

import { useEffect, useState } from "preact/hooks";
import type { ProfileInfo } from "../../api";
import { useAction, useApi, useLoad } from "../../ui/frame";
import { Group, Row } from "../../ui/Row";

export function ProfileSection() {
  const api = useApi();
  const act = useAction();
  const profile = useLoad((a) => a.getProfile());
  const [name, setName] = useState("");
  const p: ProfileInfo | undefined = profile.data;
  useEffect(() => {
    if (p) setName(p.name);
  }, [p?.name]);
  if (!p) return <p class="mute">{profile.error ?? ""}</p>;

  const saveName = async () => {
    const next = name.trim();
    if (!next || next === p.name) return setName(p.name);
    const ok = await act(() => api.setProfile({ name: next }).then(() => true), "Profile renamed");
    if (ok) profile.set({ ...p, name: next });
    else setName(p.name);
  };
  const pick = async (icon: number) => {
    if (icon === p.icon) return;
    const ok = await act(() => api.setProfile({ icon }).then(() => true), "Icon changed");
    if (ok) profile.set({ ...p, icon });
  };

  return (
    <div class="sec">
      <Group label="This profile">
        <div class="card">
          <Row id="profile-name" title="Name" detail="Shown in the profile menu and the window title">
            <input
              class="field profile-name"
              aria-label="Profile name"
              value={name}
              maxLength={50}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              onBlur={() => void saveName()}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          </Row>
        </div>
      </Group>
      <Group label="Icon">
        <div class="card profile-icons" role="radiogroup" aria-label="Profile icon">
          {p.icons.map((i) => (
            <button
              key={i.index}
              type="button"
              role="radio"
              aria-checked={i.index === p.icon}
              aria-label={`Icon ${i.index}`}
              class={`profile-icon${i.index === p.icon ? " on" : ""}`}
              onClick={() => void pick(i.index)}
            >
              <img src={i.url} alt="" width={40} height={40} />
            </button>
          ))}
        </div>
        <p class="note">The icon shows at the end of the tab strip, beside the menu chevron.</p>
      </Group>
    </div>
  );
}
