/** Offscreen document: writes text to the clipboard for the service worker, which has no DOM. */

chrome.runtime.onMessage.addListener((message: { target?: string; type?: string; text?: unknown }, sender, reply) => {
  if (message?.target !== "offscreen" || message.type !== "copy" || sender.id !== chrome.runtime.id) return false;
  if (typeof message.text !== "string" || message.text.length > 8192) return false;
  const area = document.getElementById("text") as HTMLTextAreaElement;
  area.value = message.text;
  area.select();
  const ok = document.execCommand("copy");
  area.value = "";
  reply({ ok });
  return false;
});
