/**
 * Settings › Profile: this profile's name and icon, as Aside lets you set them. The icon shows in
 * the chevron at the end of the tab strip and beside the profile in its menu.
 */

import { useEffect, useState } from "preact/hooks";
import type { ProfileInfo } from "../../api";
import { useAction, useApi, useLoad } from "../../ui/frame";
import { Group, Row } from "../../ui/Row";

const PICTURE_PX = 128;
const MAX_FILE = 20 * 1024 * 1024;

/** The picture as Perch keeps it: the middle square of the image, 128 px, as base64 PNG. */
export async function squarePng(file: Blob): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose a picture: a PNG, JPEG, HEIC or similar image");
  if (file.size > MAX_FILE) throw new Error("That picture is over 20 MB. Choose a smaller one");
  const image = await createImageBitmap(file).catch(() => {
    throw new Error("That picture couldn't be opened. Try a PNG or JPEG");
  });
  const side = Math.min(image.width, image.height);
  const canvas = document.createElement("canvas");
  canvas.width = PICTURE_PX;
  canvas.height = PICTURE_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("That picture couldn't be opened. Try a PNG or JPEG");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, PICTURE_PX, PICTURE_PX);
  image.close();
  const url = canvas.toDataURL("image/png");
  return url.slice(url.indexOf(",") + 1);
}

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
  // Picking an icon also puts it back in place of a picture of the person's own.
  const pick = async (icon: number) => {
    if (icon === p.icon && !p.picture) return;
    const ok = await act(async () => {
      if (p.picture) await api.setProfilePicture(null);
      await api.setProfile({ icon });
      return true;
    }, "Icon changed");
    if (ok) profile.set({ ...p, icon, picture: null });
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    const ok = await act(async () => {
      const png = await squarePng(file);
      await api.setProfilePicture(png);
      return `data:image/png;base64,${png}`;
    }, "Picture changed");
    if (ok) profile.set({ ...p, picture: ok });
  };
  const removePicture = async () => {
    const ok = await act(() => api.setProfilePicture(null).then(() => true), "Picture removed");
    if (ok) profile.set({ ...p, picture: null });
  };
  const shown = p.picture ?? p.icons.find((i) => i.index === p.icon)?.url;

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
      <Group label="Picture">
        <div class="card">
          <Row id="profile-picture" title="Your own picture" detail="A photo or image of yours, cropped to a circle. It replaces the icon below.">
            <div class="profile-picture">
              {shown && <img class="profile-now" src={shown} alt="" width={40} height={40} />}
              <label class="btn">
                Upload a picture…
                <input
                  type="file"
                  accept="image/*"
                  class="sr-only"
                  aria-label="Upload a profile picture"
                  onChange={(e) => {
                    const input = e.target as HTMLInputElement;
                    void upload(input.files?.[0]).finally(() => (input.value = ""));
                  }}
                />
              </label>
              {p.picture && <button type="button" class="btn quiet" onClick={() => void removePicture()}>Remove</button>}
            </div>
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
              aria-checked={!p.picture && i.index === p.icon}
              aria-label={`Icon ${i.index}`}
              class={`profile-icon${!p.picture && i.index === p.icon ? " on" : ""}`}
              onClick={() => void pick(i.index)}
            >
              <img src={i.url} alt="" width={40} height={40} />
            </button>
          ))}
        </div>
        <p class="note">Your picture or icon shows at the end of the tab strip, beside the menu chevron, and in the profile menu.</p>
      </Group>
    </div>
  );
}
