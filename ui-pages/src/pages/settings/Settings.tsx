import type { ComponentType } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon, Search } from "../../ui/icons";
import { About } from "./About";
import { BuiltIn } from "./BuiltIn";
import { Appearance } from "./Appearance";
import { ImportSection, MemorySection, RoutinesSection } from "./Links";
import { Models } from "./Models";
import { Performance } from "./Performance";
import { Permissions } from "./Permissions";
import { Privacy } from "./Privacy";
import { SECTIONS, type SectionId, isSection, searchSettings, sectionLabel } from "./sections";
import { SkillsMcp } from "./SkillsMcp";
import "./settings.css";

const PAGES: Readonly<Record<SectionId, ComponentType>> = {
  appearance: Appearance, models: Models, skills: SkillsMcp, permissions: Permissions, privacy: Privacy, performance: Performance, builtin: BuiltIn,
  memory: MemorySection, routines: RoutinesSection, import: ImportSection, about: About,
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

  const results = searchSettings(query);
  const Page = PAGES[section];
  return (
    <div class="settings">
      <nav class="snav" aria-label="Settings">
        <div class="snav-search">
          <Icon of={Search} size={14} />
          <input
            type="search"
            aria-label="Search settings"
            placeholder="Search settings"
            value={query}
            onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          />
        </div>
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            class="row"
            aria-current={!query && s.id === section ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              go(s.id);
            }}
          >
            {s.label}
          </a>
        ))}
      </nav>
      <main class="spage">
        {query.trim() ? (
          <>
            <h1 tabIndex={-1}>Search results</h1>
            {results.length ? (
              <ul class="card results" aria-label="Results">
                {results.map((r) => (
                  <li key={r.anchor}>
                    <button type="button" class="result" onClick={() => go(r.section, r.anchor)}>
                      <span class="n">{r.title}</span>
                      <span class="cap">{sectionLabel(r.section)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="mute">No settings match “{query.trim()}”</p>
            )}
          </>
        ) : (
          <>
            <h1 ref={heading} tabIndex={-1}>{sectionLabel(section)}</h1>
            <Page key={section} />
          </>
        )}
      </main>
    </div>
  );
}
