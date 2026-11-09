/**
 * A pill that opens a list of choices above it. Arrow keys move, Enter picks, Escape closes, Tab
 * closes and moves on. Picking or Escape puts focus back on the pill.
 */

import { Fragment, type ComponentChildren, type VNode } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { Icon } from "./icon";

/** `icon` is a small mark before the label, such as the model provider's. */
export type Choice<T extends string> = { value: T; label: string; hint?: string; group?: string; icon?: VNode | null };

type MenuProps<T extends string> = {
  label: string;
  /** What the pill shows. */
  children: ComponentChildren;
  choices: Choice<T>[];
  selected: T[];
  onPick: (choice: Choice<T>) => void;
  mono?: boolean;
  align?: "start" | "end";
  /** What an open list with no choices says. */
  empty?: string;
};

export function Menu<T extends string>({ label, children, choices, selected, onPick, mono, align = "start", empty = "Nothing here yet" }: MenuProps<T>) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const first = choices.findIndex((c) => selected.includes(c.value));
    setActive(first < 0 ? 0 : first);
    list.current?.focus();
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const pick = (i: number) => {
    const choice = choices[i];
    if (!choice) return;
    onPick(choice);
    setOpen(false);
    button.current?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Tab") return setOpen(false);
    if (e.key === "Escape") {
      setOpen(false);
      button.current?.focus();
    } else if (e.key === "ArrowDown") setActive((i) => Math.min(choices.length - 1, i + 1));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
    else if (e.key === "Enter" || e.key === " ") pick(active);
    else return;
    e.preventDefault();
  };

  return (
    <div class="menu-wrap" ref={root}>
      <button ref={button} type="button" class={mono ? "pill mono" : "pill"} aria-haspopup="listbox" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen(!open)}>
        <span class="pill-t">{children}</span>
        <Icon name="down" size={12} />
      </button>
      {open && (
        <ul class={`menu ${align}`} role="listbox" aria-label={label} tabIndex={-1} ref={list} onKeyDown={onKey} aria-activedescendant={`${id}-${active}`}>
          {choices.length === 0 && (
            <li class="menu-empty" role="option" aria-disabled="true" aria-selected="false">
              {empty}
            </li>
          )}
          {choices.map((c, i) => (
            <Fragment key={c.value}>
              {c.group && c.group !== choices[i - 1]?.group && (
                <li class="menu-group" role="presentation">
                  {c.group}
                </li>
              )}
              <li
                id={`${id}-${i}`}
                role="option"
                aria-selected={selected.includes(c.value)}
                class={i === active ? "active" : ""}
                onPointerEnter={() => setActive(i)}
                onClick={() => pick(i)}
              >
                <span class="opt-label">
                  {c.icon}
                  {c.label}
                </span>
                {c.hint && <span class="opt-hint">{c.hint}</span>}
                {selected.includes(c.value) && <Icon name="check" size={14} />}
              </li>
            </Fragment>
          ))}
        </ul>
      )}
    </div>
  );
}
