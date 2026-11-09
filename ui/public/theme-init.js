// Sets the theme before first paint, so a light Mac never sees the Ink default flash. It resolves
// "system" the way resolveTheme() does (src/theme/theme.ts); boot applies the full config later.
// A file, not an inline script: the pages' CSP allows scripts from 'self' only.
(() => {
  const root = document.documentElement;
  const app = window.perchApp || {};
  const media = (q) => window.matchMedia(q).matches;
  const theme = app.theme || "system";
  root.dataset.theme = theme !== "system" ? theme : media("(prefers-contrast: more)") ? "contrast" : media("(prefers-color-scheme: dark)") ? "ink" : "paper";
  if (app.accent) root.dataset.accent = app.accent;
})();
