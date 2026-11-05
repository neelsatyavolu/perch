import type { ComponentChildren } from "preact";
import { focusSibling, nextIndex } from "./roving";

export type Option<T extends string> = { readonly value: T; readonly label: ComponentChildren; readonly name?: string };

type Props<T extends string> = {
  readonly label: string;
  readonly value: T;
  readonly options: readonly Option<T>[];
  readonly onChange: (value: T) => void;
  readonly class?: string;
};

/** A segmented control: a radio group, one tab stop, arrow keys move and select. */
export function Segmented<T extends string>({ label, value, options, onChange, class: cls }: Props<T>) {
  const selected = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div class={`seg ${cls ?? ""}`} role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={i === selected ? "true" : "false"}
          aria-label={o.name}
          tabIndex={i === selected ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            const next = nextIndex(e.key, i, options.length);
            if (next === null) return;
            e.preventDefault();
            onChange(options[next]!.value);
            focusSibling(e.currentTarget, "[role=radio]", next);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
