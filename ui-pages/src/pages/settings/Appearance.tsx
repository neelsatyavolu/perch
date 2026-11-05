import type { Density } from "../../api";
import { ACCENTS, ACCENT_NAMES, type DarkThemeName, THEMES, THEME_NAMES } from "../../theme/tokens";
import { useAppearance } from "../../ui/frame";
import { Group, Row } from "../../ui/Row";
import { Segmented } from "../../ui/Segmented";
import { Swatches } from "../../ui/Swatches";
import { Switch } from "../../ui/Switch";

const DARK_THEMES = THEME_NAMES.filter((t): t is DarkThemeName => t !== "paper");

export function Appearance() {
  const { appearance: a, update } = useAppearance();
  const themes = THEME_NAMES.map((t) => ({ value: t, label: THEMES[t].label, bg: THEMES[t].card, fg: THEMES[t].ink }));
  const accentBg = THEMES[a.theme].card;
  const accents = ACCENT_NAMES.map((n) => ({ value: n, label: ACCENTS[n].label, bg: accentBg, fg: THEMES[a.theme].dark ? ACCENTS[n].dark : ACCENTS[n].light }));

  return (
    <div class="sec">
      <Group label="Colour">
        <div class="card">
          <div id="theme" class="srow noicon stack">
            <div>
              <div class="n">Theme</div>
              <div class="d">Changes every surface and text colour in Perch at once. Contrast turns on by itself with macOS Increase Contrast.</div>
            </div>
            <Swatches label="Theme" value={a.theme} options={themes} onChange={(theme) => update({ theme, matchSystem: false })} />
          </div>
          <div id="accent" class="srow noicon stack">
            <div>
              <div class="n">Accent colour</div>
              <div class="d">Used for focus rings, the selected row, links in chat and the perch dot</div>
            </div>
            <Swatches label="Accent" value={a.accent} options={accents} onChange={(accent) => update({ accent })} />
          </div>
          <Row id="match-system" title="Match system" detail="Use Paper when macOS is light and your dark theme when it's dark">
            <Switch label="Match system" describedBy="match-system-d" checked={a.matchSystem} onChange={(matchSystem) => update({ matchSystem })} />
          </Row>
          {a.matchSystem && (
            <Row id="dark-theme" title="Dark theme" detail="The theme Perch uses when macOS is dark" sub>
              <select class="picker" aria-label="Dark theme" value={a.darkTheme} onChange={(e) => update({ darkTheme: (e.currentTarget as HTMLSelectElement).value as DarkThemeName })}>
                {DARK_THEMES.map((t) => <option key={t} value={t}>{THEMES[t].label}</option>)}
              </select>
            </Row>
          )}
        </div>
      </Group>
      <Group label="Window">
        <div class="card">
          <Row id="hide-chrome" title="Hide tab strip and bookmarks bar" detail="⌘L shows the address bar and ⌃Tab shows your tabs">
            <Switch label="Hide tab strip and bookmarks bar" describedBy="hide-chrome-d" checked={a.hideChrome} onChange={(hideChrome) => update({ hideChrome })} />
          </Row>
          <Row id="reveal-on-hover" title="Show the bars at the top edge" detail="With the bars hidden, move the pointer to the top of the window to show them" sub>
            <Switch label="Show the bars at the top edge" describedBy="reveal-on-hover-d" checked={a.revealOnHover} disabled={!a.hideChrome} onChange={(revealOnHover) => update({ revealOnHover })} />
          </Row>
          <Row id="density" title="Density" detail="Compact fits more tabs and rows on screen">
            <Segmented<Density> label="Density" value={a.density} onChange={(density) => update({ density })} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} />
          </Row>
        </div>
      </Group>
    </div>
  );
}
