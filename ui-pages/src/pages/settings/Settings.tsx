import type { ComponentType } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { LucideIcon } from "lucide-preact";
import {
  ArrowDownToLine, Box, Brain, ChevronRight, Gauge, Icon, Info, Lock, Palette, Plug, Puzzle, RefreshCw, Repeat, Search, ShieldCheck, User,
} from "../../ui/icons";
import { About } from "./About";
import { BuiltIn } from "./BuiltIn";
import { Appearance } from "./Appearance";
import { ImportSection, MemorySection, RoutinesSection } from "./Links";
import { Models } from "./Models";
import { Performance } from "./Performance";
import { Permissions } from "./Permissions";
import { Privacy } from "./Privacy";
import { ProfileSection } from "./Profile";
import { NAV_GROUPS, type SectionId, isSection, searchSettings, sectionLabel } from "./sections";
import { SkillsMcp } from "./SkillsMcp";
import { Sync } from "./Sync";
import "./settings.css";

const PAGES: Readonly<Record<SectionId, ComponentType>> = {
  profile: ProfileSection, appearance: Appearance, models: Models, skills: SkillsMcp, permissions: Permissions, privacy: Privacy, performance: Performance, sync: Sync, builtin: BuiltIn,
  memory: MemorySection, routines: RoutinesSection, import: ImportSection, about: About,
};

const NAV_ICONS: Readonly<Record<SectionId, LucideIcon>> = {
  profile: User, appearance: Palette, privacy: Lock, sync: RefreshCw, import: ArrowDownToLine, models: Box, skills: Plug, permissions: ShieldCheck,
  memory: Brain, routines: Repeat, performance: Gauge, builtin: Puzzle, about: Info,
};

const fromHash = (): SectionId => {
  const id = window.location.hash.replace(/^#/, "").split("/")[0] ?? "";
  return isSection(id) ? id : "appearance";
};

/** Marks the row a search result pointed at, once its section has loaded. */
function useHighlight(anchor: string | null) {
  useEffect(() => {
    if (!anchor) return;
    let tries = 0;
    let el: HTMLElement | null = null;
    const timer = setInterval(() => {
      el = document.getElementById(anchor);
      if (el || ++tries > 40) {
        clearInterval(timer);
        el?.classList.add("hit");
        el?.scrollIntoView?.({ block: "center" });
        el?.querySelector<HTMLElement>("button, select, input, a")?.focus({ preventScroll: true });
      }
    }, 25);
    return () => {
      clearInterval(timer);
      el?.classList.remove("hit");
    };
  }, [anchor]);
}

/** Settings: one searchable page with grouped sections (spec 6.8). */
export function Settings() {
  const [section, setSection] = useState<SectionId>(fromHash);
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useHighlight(hit);

  useEffect(() => {
    const onHash = () => setSection(fromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (id: SectionId, anchor: string | null = null) => {
    setSection(id);
    setQuery("");
    setHit(anchor);
    if (window.location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
    if (!anchor) requestAnimationFrame(() => heading.current?.focus());
  };

  // In a narrow window the nav is one scrolling strip; keep the current section in view.
  useEffect(() => {
    document.querySelector(".snav a[aria-current=page]")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [section]);

  const results = searchSettings(query);
  /** While searching, the section of the top result keeps a faint mark in the nav. */
  const hinted = query.trim() ? results[0]?.section : undefined;
  const Page = PAGES[section];
  return (
    <div class="settings">
      <nav class="snav" aria-label="Settings">
        <div class="snav-search">
          <Icon of={Search} />
          <input
            type="search"
            aria-label="Search settings"
            placeholder="Search settings"
            value={query}
            onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          />
        </div>
        {NAV_GROUPS.map((g) => (
          <div class="snav-group" key={g.label || "more"}>
            {g.label && <div class="snav-lbl" aria-hidden="true">{g.label}</div>}
            <ul aria-label={g.label || "More"}>
              {g.ids.map((id) => (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    class={id === hinted ? "row hint" : "row"}
                    aria-current={!query && id === section ? "page" : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      go(id);
                    }}
                  >
                    <Icon of={NAV_ICONS[id]} />
                    <span>{sectionLabel(id)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <main class="spage-panel">
        <div class="spage">
          {query.trim() ? (
            <>
              <h1 tabIndex={-1}>Search results</h1>
              {results.length ? (
                <ul class="card results" aria-label="Results">
                  {results.map((r) => (
                    <li key={r.anchor}>
                      <button type="button" class="result" onClick={() => go(r.section, r.anchor)}>
                        <span class="rt">
                          <span class="n">{r.title}</span>
                          <span class="cap">{sectionLabel(r.section)}</span>
                        </span>
                        <Icon of={ChevronRight} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div class="no-results">
                  <p class="mute">No settings match “{query.trim()}”</p>
                  <button
                    type="button"
                    class="btn"
                    onClick={() => {
                      setQuery("");
                      requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".snav-search input")?.focus());
                    }}
                  >
                    Clear search
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <h1 ref={heading} tabIndex={-1}>{sectionLabel(section)}</h1>
              <Page key={section} />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
