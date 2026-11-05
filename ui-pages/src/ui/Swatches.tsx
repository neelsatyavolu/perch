import { focusSibling, nextIndex } from "./roving";

export type Swatch<T extends string> = { readonly value: T; readonly label: string; readonly bg: string; readonly fg: string };

type Props<T extends string> = {
  readonly label: string;
  readonly value: T;
  readonly options: readonly Swatch<T>[];
  readonly onChange: (value: T) => void;
};

/** Theme and accent pickers: a radio group of swatches, each with its name under it. */
export function Swatches<T extends string>({ label, value, options, onChange }: Props<T>) {
  const selected = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div class="swatches" role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          class="sw"
          aria-checked={i === selected ? "true" : "false"}
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
          <span class="sw-box" style={{ background: o.bg }} aria-hidden="true">
            <i style={{ background: o.fg }} />
          </span>
          <span class="sw-name">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
