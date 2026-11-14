/**
 * The effort pill and its popover: a slider with one stop per effort the model takes, and, for a
 * ChatGPT model, the Fast mode switch. Arrow keys, Home and End move the slider; Escape closes and
 * puts focus back on the pill, as the other pickers do.
 */

import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { Effort } from "../api/types";
import { Icon } from "./icon";
import { EFFORT_LABEL } from "./model-menu";

type EffortMenuProps = {
  efforts: readonly Effort[];
  effort: Effort;
  onEffort: (effort: Effort) => void;
  /** Whether the chat runs on OpenAI's fast tier; the switch shows only when `onFast` is given. */
  fast?: boolean;
  onFast?: (fast: boolean) => void;
};

/** Models that run on the ChatGPT subscription (through Codex) take OpenAI's fast tier. */
export const takesFastMode = (modelId: string | undefined): boolean => Boolean(modelId?.startsWith("codex:"));

const KEYS: Record<string, (at: number, last: number) => number> = {
  ArrowLeft: (at) => at - 1,
  ArrowDown: (at) => at - 1,
  ArrowRight: (at) => at + 1,
  ArrowUp: (at) => at + 1,
  Home: () => 0,
  End: (_, last) => last,
};

export function EffortMenu({ efforts, effort, onEffort, fast = false, onFast }: EffortMenuProps) {
  const [open, setOpen] = useState(false);
  const fastId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const slider = useRef<HTMLDivElement>(null);
  const at = Math.max(0, efforts.indexOf(effort));
  const last = efforts.length - 1;
  const label = EFFORT_LABEL[effort];

  useEffect(() => {
    if (!open) return;
    slider.current?.focus();
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const choose = (i: number) => {
    const next = efforts[Math.min(last, Math.max(0, i))];
    if (next && next !== effort) onEffort(next);
  };
  /** The stop nearest the pointer, along the track between the first and last stop. */
  const fromPointer = (e: PointerEvent) => {
    const box = slider.current?.getBoundingClientRect();
    if (!box || box.width === 0 || last === 0) return;
    const step = box.width / efforts.length;
    choose(Math.round((e.clientX - box.left - step / 2) / step));
  };
  const onKey = (e: KeyboardEvent) => {
    const move = KEYS[e.key];
    if (!move) return;
    e.preventDefault();
    choose(move(at, last));
  };
  const onPopKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    setOpen(false);
    button.current?.focus();
  };
  const onBlur = (e: FocusEvent) => {
    if (!root.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
  };
  // Centre of the chosen stop, as a share of the slider's width (each stop sits in the middle of its column).
  const pos = (i: number) => `${((i + 0.5) / efforts.length) * 100}%`;

  return (
    <div class="menu-wrap eff-wrap" ref={root} onFocusOut={onBlur}>
      <button ref={button} type="button" class="pill" aria-haspopup="dialog" aria-expanded={open} aria-label="Effort" title={`Effort: ${label}${onFast && fast ? ", Fast mode" : ""}`} onClick={() => setOpen(!open)}>
        <span class="pill-t">
          <span class="eff-i">
            <Icon name="gauge" size={14} />
          </span>
          <span class="eff-t">
            {label}
            {onFast && fast && <span class="eff-fast-mark"> · Fast</span>}
          </span>
        </span>
        <Icon name="down" size={12} />
      </button>
      {open && (
        <div class="menu end eff-pop" role="dialog" aria-label="Effort" onKeyDown={onPopKey}>
          <div class="eff-head">
            <span>Effort</span>
            <span class="eff-now">{label}</span>
          </div>
          <div
            ref={slider}
            class="eff-slider"
            role="slider"
            tabIndex={0}
            aria-label="Effort"
            aria-valuemin={0}
            aria-valuemax={last}
            aria-valuenow={at}
            aria-valuetext={label}
            style={{ "--from": pos(0), "--to": pos(last), "--at": pos(at), "--share": last > 0 ? at / last : 0 }}
            onKeyDown={onKey}
            onPointerDown={(e) => {
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
              fromPointer(e);
            }}
            onPointerMove={(e) => {
              if ((e.currentTarget as HTMLElement).hasPointerCapture?.(e.pointerId)) fromPointer(e);
            }}
          >
            <span class="eff-track" aria-hidden="true">
              <span class="eff-fill" />
            </span>
            {efforts.map((e, i) => (
              <span key={e} class={`eff-stop${i <= at ? " on" : ""}`} style={{ left: pos(i) }} aria-hidden="true" />
            ))}
            <span class="eff-knob" aria-hidden="true" />
          </div>
          <div class="eff-labels" style={{ "--cols": efforts.length }} aria-hidden="true">
            {efforts.map((e, i) => (
              <span key={e} class={i === at ? "now" : undefined} onClick={() => choose(i)}>
                <span>{EFFORT_LABEL[e]}</span>
              </span>
            ))}
          </div>
          {onFast && (
            <div class="eff-fast">
              <span class="eff-fast-t">
                <span id={fastId}>Fast mode</span>
                <span class="eff-fast-h">Faster replies. Uses your ChatGPT plan's limits faster.</span>
              </span>
              <button type="button" role="switch" class="switch" aria-checked={fast} aria-labelledby={fastId} onClick={() => onFast(!fast)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
