import type { DetectedBrowser, FileChoice, ImportKind, ImportNeed, SystemAccess } from "../../api";
import { IMPORT_KINDS, IMPORT_NEEDS } from "../../lib/labels";

export const ASIDE_KINDS: readonly ImportKind[] = ["aside-memory", "aside-skills", "aside-chats", "aside-preferences"];

/** "Personal", or "2 profiles"; a lone profile named like its browser ("Safari") says "1 profile" instead. */
export function profileLine(browser: string, profiles: readonly { readonly name: string }[]): string {
  if (profiles.length !== 1) return `${profiles.length} profiles`;
  const name = profiles[0]!.name;
  return name.trim().toLowerCase() === browser.trim().toLowerCase() ? "1 profile" : name;
}

export function BrowserStep({ browsers, browser, profile, onBrowser, onProfile }: {
  readonly browsers: readonly DetectedBrowser[];
  readonly browser: DetectedBrowser | null;
  readonly profile: string;
  readonly onBrowser: (b: DetectedBrowser) => void;
  readonly onProfile: (p: string) => void;
}) {
  if (browsers.length === 0) return <p class="mute">No other browsers found on this Mac.</p>;
  return (
    <>
      <div class="pick-list" role="radiogroup" aria-label="Browser">
        {browsers.map((b) => (
          <label key={b.id} class={`pick ${browser?.id === b.id ? "on" : ""}`}>
            <input type="radio" name="browser" checked={browser?.id === b.id} onChange={() => onBrowser(b)} />
            <span class="tile" aria-hidden="true">{b.name.charAt(0)}</span>
            <span class="pick-t">
              <span class="ink">{b.name}</span>
              <span class="cap">{profileLine(b.name, b.profiles)}</span>
            </span>
          </label>
        ))}
      </div>
      {browser && browser.profiles.length > 1 && (
        <label class="label">
          <span>Profile</span>
          <select class="picker" value={profile} onChange={(e) => onProfile((e.currentTarget as HTMLSelectElement).value)}>
            {browser.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      )}
    </>
  );
}

export function DataStep({ browser, kinds, onToggle }: {
  readonly browser: DetectedBrowser;
  readonly kinds: readonly ImportKind[];
  readonly onToggle: (k: ImportKind) => void;
}) {
  const options = browser.options.filter((o) => o.available);
  const common = options.filter((o) => !ASIDE_KINDS.includes(o.kind));
  const extras = options.filter((o) => ASIDE_KINDS.includes(o.kind));
  const row = (o: (typeof options)[number]) => (
    <label key={o.kind} class="pick data">
      <input type="checkbox" checked={kinds.includes(o.kind)} onChange={() => onToggle(o.kind)} aria-describedby={o.needs ? `need-${o.kind}` : undefined} />
      <span class="pick-t">
        <span class="ink">{IMPORT_KINDS[o.kind].label}{o.count !== undefined && <span class="mute mono"> · {o.count.toLocaleString("en-US")}</span>}</span>
        {o.needs && <span class="cap" id={`need-${o.kind}`}>{IMPORT_NEEDS[o.needs]}</span>}
      </span>
    </label>
  );
  return (
    <fieldset class="pick-list" aria-label={`What to bring from ${browser.name}`}>
      {common.map(row)}
      {extras.length > 0 && <p class="cap pick-sub">From Aside only</p>}
      {extras.map(row)}
    </fieldset>
  );
}

const NEED_TEXT = (need: ImportNeed, browser: string): string => {
  switch (need) {
    case "full-disk-access":
      return `${browser} keeps open tabs, history and cookies where only apps with Full Disk Access can read them. Turn it on for Perch in System Settings, then come back.`;
    case "keychain":
      return `macOS asks to unlock ${browser}'s Keychain item. Choose Allow to let Perch read it once.`;
    case "csv-export":
      return "Safari doesn't share passwords with other apps. In the Passwords app choose File, then Export All Passwords, then choose that file here. Delete the file after the import; it isn't encrypted.";
    case "primary-password":
      return `If ${browser} has a primary password, Perch asks you to type it.`;
  }
};

export function PermissionStep({ browser, needs, access, csv, onOpenSettings, onChooseCsv }: {
  readonly browser: DetectedBrowser;
  readonly needs: readonly ImportNeed[];
  readonly access: SystemAccess | null;
  readonly csv: FileChoice | null;
  readonly onOpenSettings: () => void;
  readonly onChooseCsv: () => void;
}) {
  return (
    <ul class="needs">
      {needs.map((n) => (
        <li key={n} class="need">
          <p>{NEED_TEXT(n, browser.name)}</p>
          {n === "full-disk-access" && (
            access?.fullDiskAccess ? (
              <span class="status ok"><span class="dotc" />Full Disk Access is on</span>
            ) : (
              <button type="button" class="btn" onClick={onOpenSettings}>Open System Settings</button>
            )
          )}
          {n === "csv-export" && (
            <span class="need-file">
              {csv && <span class="status ok"><span class="dotc" />{csv.name}</span>}
              <button type="button" class="btn" onClick={onChooseCsv}>{csv ? "Choose another file" : "Choose exported file"}</button>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
