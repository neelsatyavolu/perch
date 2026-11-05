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
const META = 4;
const SHIFT = 8;

/** On macOS, Meta shortcuts reach text fields only as editing commands. */
const META_COMMANDS: Record<string, string> = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo" };

const PUNCTUATION: Record<string, [string, number]> = {
  ",": ["Comma", 188], ".": ["Period", 190], "/": ["Slash", 191], ";": ["Semicolon", 186], "'": ["Quote", 222],
  "[": ["BracketLeft", 219], "]": ["BracketRight", 221], "\\": ["Backslash", 220], "-": ["Minus", 189], "=": ["Equal", 187], "`": ["Backquote", 192],
};

/** Parses "Enter", "a" or "Meta+Shift+K" into a key, a CDP modifier bitmask and any macOS editing command. */
export function parseKey(combo: string): { def: KeyDef; modifiers: number; commands?: string[] } | null {
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
  const punct = PUNCTUATION[last];
  const text = modifiers & 6 ? undefined : last;
  const def: KeyDef = punct
    ? { key: last, code: punct[0], keyCode: punct[1], text }
    : { key: last, code: isLetter ? `Key${upper}` : /\d/.test(last) ? `Digit${last}` : "", keyCode: upper.charCodeAt(0), text };
  const command = modifiers & META ? (last.toLowerCase() === "z" && modifiers & SHIFT ? "redo" : META_COMMANDS[last.toLowerCase()]) : undefined;
  return command ? { def, modifiers, commands: [command] } : { def, modifiers };
}
