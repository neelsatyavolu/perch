/**
 * The model picker, in the shape of Aside's (and of the chat's, ui/src/components/model-menu.tsx):
 * a search field, one row per provider that opens its models, and Settings at the bottom. Typing
 * lists every model that matches, across providers. The search field keeps focus: arrow keys move,
 * Enter (or →) opens or picks, ← and Escape go back, Escape on the providers closes.
 */

import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { ChatEffort, ComposerModel } from "../api";
import { Check, ChevronDown, ChevronRight, ExternalLink, Icon, Search } from "./icons";
import { ProviderGlyph } from "./ProviderMark";

/** A model's name without its maker: "Sonnet 5.5", not "Claude Sonnet 5.5". */
export const modelName = (label: string): string => label.replace(/^Claude\s+/, "");

type Row =
  | { readonly kind: "provider"; readonly provider: string }
  | { readonly kind: "back"; readonly provider: string }
  | { readonly kind: "model"; readonly model: ComposerModel; readonly hint?: string }
  | { readonly kind: "settings" };

type Props = {
  readonly models: readonly ComposerModel[];
  readonly selected: string;
  readonly onPick: (model: ComposerModel) => void;
  /** Opens Settings → Models; without it there is no Settings row. */
  readonly onSettings?: () => void;
  readonly children: ComponentChildren;
};

/** Every word of the query appears in the model's name or its provider's. */
export function matchModels(models: readonly ComposerModel[], query: string): ComposerModel[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter((m) => words.every((w) => `${m.label} ${m.provider}`.toLowerCase().includes(w)));
}

export const EFFORT_NAMES: Readonly<Record<ChatEffort, string>> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" };

export function ModelMenu({ models, selected, onPick, onSettings, children }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const providers = [...new Set(models.map((m) => m.provider))];
  const rows: readonly Row[] = query.trim()
    ? matchModels(models, query).map((model) => ({ kind: "model", model, hint: model.provider }))
    : view
      ? [{ kind: "back", provider: view }, ...models.filter((m) => m.provider === view).map((model): Row => ({ kind: "model", model }))]
      : [...providers.map((provider): Row => ({ kind: "provider", provider })), ...(onSettings ? [{ kind: "settings" } as const] : [])];

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
    // In a provider's list, start on the chosen model (or the first one under the header).
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
    const row = rows[active];
    if (e.key === "Tab") return setOpen(false);
    if (e.key === "Escape") {
      if (query) setQuery("");
      else if (view) show(null);
      else close();
    } else if (e.key === "ArrowDown") setActive((i) => Math.min(rows.length - 1, i + 1));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
    else if (e.key === "Enter") activate(row);
    else if (e.key === "ArrowRight" && !query && row?.kind === "provider") activate(row);
    else if (e.key === "ArrowLeft" && !query && view && atStart) show(null);
    else return;
    e.preventDefault();
  };

  const item = (row: Row, i: number) => {
    const props = { id: `${id}-${i}`, role: "option" as const, class: i === active ? "active" : undefined, onPointerEnter: () => setActive(i), onClick: () => activate(row) };
    switch (row.kind) {
      case "provider":
        return (
          <li key={`p-${row.provider}`} {...props} aria-selected={false} data-kind="provider">
            <span class="mm-l"><ProviderGlyph provider={row.provider} />{row.provider}</span>
            <Icon of={ChevronRight} size={14} />
          </li>
        );
      case "back":
        return [
          <li key="back" {...props} aria-selected={false} data-kind="back" aria-label={`Back to providers from ${row.provider}`}>
            <span class="mm-l"><ProviderGlyph provider={row.provider} />{row.provider}</span>
            <Icon of={ChevronDown} size={14} />
          </li>,
          <li key="sep" class="mm-sep" role="presentation" />,
        ];
      case "settings":
        return [
          <li key="sep" class="mm-sep" role="presentation" />,
          <li key="settings" {...props} aria-selected={false} data-kind="settings">
            <span class="mm-l">Settings</span>
            <Icon of={ExternalLink} size={14} />
          </li>,
        ];
      default: {
        const chosen = row.model.id === selected;
        return (
          <li key={row.model.id} {...props} aria-selected={chosen} data-kind="model">
            <span class="mm-l">
              {row.hint !== undefined && <ProviderGlyph provider={row.model.provider} />}
              {modelName(row.model.label)}
              {row.hint && <span class="mm-hint">{row.hint}</span>}
            </span>
            {chosen && <Icon of={Check} size={14} />}
          </li>
        );
      }
    }
  };

  return (
    <div class="mm-wrap" ref={root}>
      <button ref={button} type="button" class="mm-pill" aria-haspopup="dialog" aria-expanded={open} aria-label="Model for the task" onClick={toggle}>
        {children}
        <Icon of={ChevronDown} size={14} />
      </button>
      {open && (
        <div class="mm" role="dialog" aria-label="Choose a model">
          <label class="mm-search">
            <Icon of={Search} size={14} />
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
                setQuery(e.currentTarget.value);
                setActive(0);
              }}
              onKeyDown={onKey}
            />
          </label>
          <ul id={`${id}-list`} role="listbox" aria-label={view ?? "Providers"}>
            {rows.length === 0 && <li class="mm-empty" role="option" aria-disabled="true" aria-selected={false}>No model matches</li>}
            {rows.map(item)}
          </ul>
        </div>
      )}
    </div>
  );
}
