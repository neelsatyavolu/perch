import { focusSibling, nextIndex } from "./roving";

type Tab<T extends string> = { readonly value: T; readonly label: string };

type Props<T extends string> = {
  readonly label: string;
  /** Tabs get ids `${idPrefix}-tab-${value}` and control `${idPrefix}-panel-${value}`. */
  readonly idPrefix: string;
  readonly value: T;
  readonly tabs: readonly Tab<T>[];
  readonly onChange: (value: T) => void;
};

export function TabList<T extends string>({ label, idPrefix, value, tabs, onChange }: Props<T>) {
  const selected = Math.max(0, tabs.findIndex((t) => t.value === value));
  return (
    <div class="tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${t.value}`}
          aria-controls={`${idPrefix}-panel-${t.value}`}
          aria-selected={i === selected ? "true" : "false"}
          tabIndex={i === selected ? 0 : -1}
          onClick={() => onChange(t.value)}
          onKeyDown={(e) => {
            const next = nextIndex(e.key, i, tabs.length);
            if (next === null) return;
            e.preventDefault();
            onChange(tabs[next]!.value);
            focusSibling(e.currentTarget, "[role=tab]", next);
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
