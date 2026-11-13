import type { DetectedBrowser, FileChoice, ImportKind, ImportNeed, SystemAccess } from "../../api";
import { IMPORT_KINDS, IMPORT_NEEDS } from "../../lib/labels";

export const ASIDE_KINDS: readonly ImportKind[] = ["aside-memory", "aside-skills", "aside-chats", "aside-preferences"];

/** "Personal", or "2 profiles"; a lone profile named like its browser ("Safari") says "1 profile" instead. */
export function profileLine(browser: string, profiles: readonly { readonly name: string }[]): string {
  if (profiles.length !== 1) return `${profiles.length} profiles`;
  const name = profiles[0]!.name;
  return name.trim().toLowerCase() === browser.trim().toLowerCase() ? "1 profile" : name;
}

/** "Used today", "Used yesterday", "Used 3 days ago", "Used in March". */
export function lastUsedLine(at: number, now = Date.now()): string {
  const day = 24 * 60 * 60 * 1000;
  const days = Math.floor((startOfDay(now) - startOfDay(at)) / day);
  if (days <= 0) return "Used today";
  if (days === 1) return "Used yesterday";
  if (days < 30) return `Used ${days} days ago`;
  const d = new Date(at);
  const month = d.toLocaleString("en-US", { month: "long" });
  return new Date(now).getFullYear() === d.getFullYear() ? `Used in ${month}` : `Used in ${month} ${d.getFullYear()}`;
}

function startOfDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function BrowserStep({ browsers, browser, profiles, onBrowser, onToggleProfile }: {
  readonly browsers: readonly DetectedBrowser[];
  readonly browser: DetectedBrowser | null;
  readonly profiles: readonly string[];
  readonly onBrowser: (b: DetectedBrowser) => void;
  readonly onToggleProfile: (id: string) => void;
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
              <span class="cap">{profileLine(b.name, b.profiles)}{b.lastUsed ? ` · ${lastUsedLine(b.lastUsed)}` : ""}</span>
            </span>
          </label>
        ))}
      </div>
      {browser && browser.profiles.length > 1 && (
        <fieldset class="pick-list profiles" aria-label={`Profiles to bring from ${browser.name}`}>
          <p class="cap pick-sub">Profiles. Each one's bookmarks go into their own folder.</p>
          {browser.profiles.map((p) => (
            <label key={p.id} class="pick data">
              <input type="checkbox" checked={profiles.includes(p.id)} onChange={() => onToggleProfile(p.id)} />
              <span class="pick-t"><span class="ink">{p.name}</span></span>
            </label>
          ))}
        </fieldset>
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
      return `${browser} keeps its data where only apps with Full Disk Access can read it. Turn it on for Perch in System Settings, then come back.`;
    case "keychain":
      return `macOS asks to unlock ${browser}'s Keychain item. Choose Allow to let Perch read it once.`;
    case "csv-export":
      return browser === "Safari"
        ? "Safari doesn't share passwords with other apps. In the Passwords app choose File, then Export All Passwords, then choose that file here. Delete the file after the import; it isn't encrypted."
        : `${browser} keeps passwords encrypted with its own key. In ${browser}, open about:logins, choose the ••• menu, then Export Passwords, then choose that file here. Delete the file after the import; it isn't encrypted.`;
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
