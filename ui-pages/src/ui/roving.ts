/** Arrow-key movement for radio groups and tab lists (WAI-ARIA authoring practices). */

const KEYS: Record<string, (i: number, n: number) => number> = {
  ArrowRight: (i, n) => (i + 1) % n,
  ArrowDown: (i, n) => (i + 1) % n,
  ArrowLeft: (i, n) => (i - 1 + n) % n,
  ArrowUp: (i, n) => (i - 1 + n) % n,
  Home: () => 0,
  End: (_i, n) => n - 1,
};

/** Returns the next index for a key, or null when the key doesn't move. */
export function nextIndex(key: string, index: number, count: number): number | null {
  const move = KEYS[key];
  return move && count > 0 ? move(index, count) : null;
}

/** Moves focus to the item at `index` inside the same group after Preact re-renders. */
export function focusSibling(from: HTMLElement, selector: string, index: number): void {
  const group = from.parentElement;
  const target = group?.querySelectorAll<HTMLElement>(selector)[index];
  target?.focus();
}
