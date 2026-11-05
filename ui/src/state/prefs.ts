/** Per-viewer layout preferences (pane width, list open). Storage may be missing; defaults apply. */

export function readPref<T extends number | boolean>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`perch.${key}`);
    if (raw === null) return fallback;
    const value = JSON.parse(raw) as unknown;
    return typeof value === typeof fallback ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writePref<T extends number | boolean>(key: string, value: T): T {
  try {
    localStorage.setItem(`perch.${key}`, JSON.stringify(value));
  } catch {
    // Private windows and locked-down profiles have no storage; the layout still works.
  }
  return value;
}
