/** Key definitions for Input.dispatchKeyEvent. */

export type KeyDef = { key: string; code: string; keyCode: number; text?: string };

const NAMED: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
};
const MODIFIERS: Record<string, number> = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

/** Parses "Enter", "a" or "Meta+Shift+K" into a key and a CDP modifier bitmask. */
export function parseKey(combo: string): { def: KeyDef; modifiers: number } | null {
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  const last = parts.pop();
  if (!last) return null;
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIERS[part.toLowerCase()];
    if (bit === undefined) return null;
    modifiers |= bit;
  }
  const named = NAMED[last.toLowerCase()];
  if (named) return { def: named, modifiers };
  if (last.length !== 1) return null;
  const upper = last.toUpperCase();
  const isLetter = /[A-Z]/.test(upper);
  return {
    def: { key: last, code: isLetter ? `Key${upper}` : /\d/.test(last) ? `Digit${last}` : "", keyCode: upper.charCodeAt(0), text: modifiers & 6 ? undefined : last },
    modifiers,
  };
}
