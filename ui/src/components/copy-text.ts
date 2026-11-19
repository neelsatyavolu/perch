/**
 * Copies text to the clipboard. The async Clipboard API comes first; where it is refused (a chat
 * frame the shell has not allowed clipboard-write), a hidden textarea and execCommand("copy") still
 * copy during the click. Throws when neither copied, so a button never says "Copied" for nothing.
 */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard) return await navigator.clipboard.writeText(text);
  } catch {
    // Falls through to the old way below.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const ok = document.execCommand?.("copy") ?? false;
  area.remove();
  if (!ok) throw new Error("The clipboard isn't available here");
}
