/** Key definitions for Input.dispatchKeyEvent. */

/** `shift` marks a character typed with Shift held on a US keyboard ("!", "(", "A"). */
export type KeyDef = { key: string; code: string; keyCode: number; text?: string; shift?: boolean };

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

/**
 * Shifted symbols share their key with an unshifted one. Their own char codes are the key codes
 * of PageUp, End, Home and the arrows ("$" is 36, Home; "(" is 40, ArrowDown), which move the
 * caret and drive suggestion lists, so they must be sent as their real key with Shift.
 */
const SHIFTED: Record<string, [string, number]> = {
  "!": ["Digit1", 49], "@": ["Digit2", 50], "#": ["Digit3", 51], "$": ["Digit4", 52], "%": ["Digit5", 53], "^": ["Digit6", 54],
  "&": ["Digit7", 55], "*": ["Digit8", 56], "(": ["Digit9", 57], ")": ["Digit0", 48], "_": ["Minus", 189], "+": ["Equal", 187],
  "{": ["BracketLeft", 219], "}": ["BracketRight", 221], "|": ["Backslash", 220], ":": ["Semicolon", 186], '"': ["Quote", 222],
  "<": ["Comma", 188], ">": ["Period", 190], "?": ["Slash", 191], "~": ["Backquote", 192],
};

/** Parses "Enter", "a", " " or "Meta+Shift+K" into a key, a CDP modifier bitmask and any macOS editing command. */
export function parseKey(combo: string): { def: KeyDef; modifiers: number; commands?: string[] } | null {
  // A literal space or plus sign is the key itself, not a separator.
  if (combo === " ") return { def: NAMED.space!, modifiers: 0 };
  if (combo === "+") return { def: charDef("+", 0), modifiers: SHIFT };
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
  const def = charDef(last, modifiers);
  if (def.shift) modifiers |= SHIFT;
  const command = modifiers & META ? (last.toLowerCase() === "z" && modifiers & SHIFT ? "redo" : META_COMMANDS[last.toLowerCase()]) : undefined;
  return command ? { def, modifiers, commands: [command] } : { def, modifiers };
}

/** The key for one printable character; with Control or Meta held it types no text. */
function charDef(ch: string, modifiers: number): KeyDef {
  const upper = ch.toUpperCase();
  const isLetter = /[A-Z]/.test(upper);
  const punct = PUNCTUATION[ch];
  const shifted = SHIFTED[ch];
  const text = modifiers & 6 ? undefined : ch;
  if (punct) return { key: ch, code: punct[0], keyCode: punct[1], text };
  if (shifted) return { key: ch, code: shifted[0], keyCode: shifted[1], text, shift: true };
  if (isLetter || /\d/.test(ch)) return { key: ch, code: isLetter ? `Key${upper}` : `Digit${ch}`, keyCode: upper.charCodeAt(0), text };
  // Not on a US keyboard: no key code a page could mistake for a navigation key.
  return { key: ch, code: "", keyCode: 0, text };
}

/** The key that types one character, or null when it has no key on a US keyboard (it is inserted instead). A newline is inserted too: Enter would submit a form.. */
export function keyForChar(ch: string): KeyDef | null {
  if (ch === " ") return NAMED.space!;
  if (!/^[\x21-\x7e]$/.test(ch)) return null;
  const def = charDef(ch, 0);
  // Capitals are typed with Shift held; parseKey leaves them alone, since "Control+A" means Control+a.
  return /[A-Z]/.test(ch) ? { ...def, shift: true } : def;
}
