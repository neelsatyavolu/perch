/**
 * The model picker, in the shape of Aside's: a search field, one row per provider that opens its
 * models, and Settings at the bottom. Typing lists every model that matches, across providers.
 * The search field keeps focus: arrow keys move, Enter (or →) opens or picks, ← and Escape go back,
 * Escape on the providers closes. Picking or closing puts focus back on the pill.
 */

import { type ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { Effort, ModelInfo } from "../api/types";
import { Icon } from "./icon";
import { ProviderMark } from "./provider-mark";

/** A model's name without its maker: "Sonnet 5.5", not "Claude Sonnet 5.5". */
export const modelName = (label: string): string => label.replace(/^Claude\s+/, "");

type Row =
  | { kind: "provider"; provider: string }
  | { kind: "back"; provider: string }
  | { kind: "model"; model: ModelInfo; hint?: string }
  | { kind: "settings" };

type Props = {
  models: ModelInfo[];
  selected: string;
  onPick: (model: ModelInfo) => void;
  /** Opens Perch's model settings; without it there is no Settings row. */
  onSettings?: () => void;
  align?: "start" | "end";
  children: ComponentChildren;
};

/** Every word of the query appears in the model's name or its provider's. */
export function matchModels(models: readonly ModelInfo[], query: string): ModelInfo[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter((m) => {
    const text = `${m.label} ${m.provider}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

export function ModelMenu({ models, selected, onPick, onSettings, align = "end", children }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const providers = [...new Set(models.map((m) => m.provider))];
  const rows: Row[] = query.trim()
    ? matchModels(models, query).map((model) => ({ kind: "model", model, hint: model.provider }))
    : view
      ? [{ kind: "back", provider: view }, ...models.filter((m) => m.provider === view).map((model): Row => ({ kind: "model", model }))]
      : [...providers.map((provider): Row => ({ kind: "provider", provider })), ...(onSettings ? [{ kind: "settings" } as Row] : [])];

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const show = (next: string | null) => {
    setView(next);
    setQuery("");
    // In a provider's list, start on the chosen model (or the first model under the header).
    const at = next ? models.filter((m) => m.provider === next).findIndex((m) => m.id === selected) : -1;
    setActive(next ? (at < 0 ? 1 : at + 1) : 0);
    input.current?.focus();
  };
  const toggle = () => {
    if (!open) {
      setView(null);
      setQuery("");
      setActive(0);
    }
    setOpen(!open);
  };
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const activate = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "provider") show(row.provider);
    else if (row.kind === "back") show(null);
    else if (row.kind === "settings") {
      close();
      onSettings?.();
    } else {
      onPick(row.model);
      close();
    }
  };
  const onKey = (e: KeyboardEvent) => {
    const atStart = (e.currentTarget as HTMLInputElement).selectionStart === 0;
    if (e.key === "Tab") return setOpen(false);
    if (e.key === "Escape") {
      if (query) setQuery("");
      else if (view) show(null);
      else close();
    } else if (e.key === "ArrowDown") setActive((i) => Math.min(rows.length - 1, i + 1));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
    else if (e.key === "Enter") activate(rows[active]);
    else if (e.key === "ArrowRight" && !query && rows[active]?.kind === "provider") activate(rows[active]);
    else if (e.key === "ArrowLeft" && !query && view && atStart) show(null);
    else return;
    e.preventDefault();
  };

  return (
    <div class="menu-wrap model-wrap" ref={root}>
      <button ref={button} type="button" class="pill" aria-haspopup="dialog" aria-expanded={open} aria-label="Model" title="Model" onClick={toggle}>
        <span class="pill-t">{children}</span>
        <Icon name="down" size={12} />
      </button>
      {open && (
        <div class={`menu mm ${align}`} role="dialog" aria-label="Choose a model">
          <label class="mm-search">
            <Icon name="search" size={14} />
            <input
              ref={input}
              type="text"
              placeholder="Search models"
              aria-label="Search models"
              role="combobox"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-activedescendant={rows.length ? `${id}-${active}` : undefined}
              spellcheck={false}
              autoComplete="off"
              value={query}
              onInput={(e) => {
                setQuery((e.currentTarget as HTMLInputElement).value);
                setActive(0);
              }}
              onKeyDown={onKey}
            />
          </label>
          <ul id={`${id}-list`} role="listbox" aria-label={view ?? "Providers"}>
            {rows.length === 0 && (
              <li class="menu-empty" role="option" aria-disabled="true" aria-selected="false">
                No model matches
              </li>
            )}
            {rows.map((row, i) => {
              const common = { id: `${id}-${i}`, onPointerEnter: () => setActive(i), onClick: () => activate(row) };
              const cls = (extra: string) => [extra, i === active ? "active" : ""].filter(Boolean).join(" ");
              if (row.kind === "provider")
                return (
                  <li key={`p-${row.provider}`} role="option" aria-selected="false" class={cls("mm-provider")} {...common}>
                    <span class="opt-label">
                      <ProviderMark provider={row.provider} />
                      {row.provider}
                    </span>
                    <Icon name="right" size={14} />
                  </li>
                );
              if (row.kind === "back")
                return [
                  <li key="back" role="option" aria-selected="false" aria-label={`Back to providers from ${row.provider}`} class={cls("mm-head")} {...common}>
                    <span class="opt-label">
                      <ProviderMark provider={row.provider} />
                      {row.provider}
                    </span>
                    <Icon name="down" size={14} />
                  </li>,
                  <li key="sep" class="mm-sep" role="presentation" />,
                ];
              if (row.kind === "settings")
                return [
                  <li key="sep" class="mm-sep" role="presentation" />,
                  <li key="settings" role="option" aria-selected="false" class={cls("mm-settings")} {...common}>
                    <span class="opt-label">Settings</span>
                    <Icon name="external" size={14} />
                  </li>,
                ];
              const chosen = row.model.id === selected;
              return (
                <li key={row.model.id} role="option" aria-selected={chosen} class={cls("")} {...common}>
                  <span class="opt-check">{chosen && <Icon name="check" size={14} />}</span>
                  <span class="opt-label">
                    {row.hint !== undefined && <ProviderMark provider={row.model.provider} />}
                    {modelName(row.model.label)}
                  </span>
                  {row.hint && <span class="opt-hint">{row.hint}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Efforts as the effort picker names them. */
export const EFFORT_LABEL: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" };
const ORDER: readonly Effort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

/** The effort to keep after switching model: the same if it takes it, else the nearest below, else its lowest. */
export function fitEffort(efforts: readonly Effort[], wanted: Effort): Effort {
  if (!efforts.length || efforts.includes(wanted)) return wanted;
  const below = efforts.filter((e) => ORDER.indexOf(e) < ORDER.indexOf(wanted));
  return below.length ? below[below.length - 1]! : efforts[0]!;
}
