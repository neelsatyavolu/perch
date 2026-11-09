import { PAGE_STYLE } from "./confirm-page";

/**
 * The two pages of company sign-in. The go page asks for the number Perch shows before it sends
 * the browser to the identity provider, as the email link's confirm page does. The result page is
 * what the callback shows. Neither runs anything the server did not send with a nonce.
 */

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function shell(nonce: string, body: string, script = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Sign in to Perch</title>
<style nonce="${nonce}">
${PAGE_STYLE}</style>
</head>
<body>
<main>
  <h1>Sign in to Perch</h1>
${body}
</main>
${script}
</body>
</html>`;
}

export function goPage(nonce: string): string {
  const body = `  <p id="message">Checking the sign-in request…</p>
  <form id="form" hidden>
    <input id="number" inputmode="numeric" pattern="[0-9]{2}" maxlength="2" autocomplete="off" aria-label="Number shown in Perch" required>
    <button type="submit">Continue</button>
  </form>`;
  const script = `<script nonce="${nonce}">
(() => {
  const requestId = new URLSearchParams(location.search).get("r") || "";
  const message = document.getElementById("message");
  const form = document.getElementById("form");
  const input = document.getElementById("number");
  const say = (text, isError) => { message.textContent = text; message.className = isError ? "error" : ""; };
  const post = async (path, body) => {
    const response = await fetch("/v1/auth/oidc/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((data.error && data.error.message) || "Something went wrong. Start again in Perch.");
    return data;
  };
  if (!requestId) { say("This link is incomplete. Start again in Perch.", true); return; }
  post("go/info", { requestId }).then((data) => {
    say("Type the number Perch shows on " + data.deviceName + ". A wrong number cancels this sign-in. If you did not start this sign-in in Perch, close this tab.");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const match = Number(input.value.trim());
      if (!(Number.isInteger(match) && match >= 10 && match <= 99)) { say("Type the two-digit number Perch shows.", true); return; }
      form.hidden = true;
      try {
        const next = await post("go", { requestId, match });
        say("Opening your company's sign-in page…");
        location.assign(next.url);
      } catch (error) { say(error.message, true); }
    });
    form.hidden = false;
    input.focus();
  }).catch((error) => say(error.message, true));
})();
</script>`;
  return shell(nonce, body, script);
}

export function resultPage(nonce: string, message: string, isError: boolean): string {
  return shell(nonce, `  <p${isError ? ' class="error"' : ""}>${escapeHtml(message)}</p>`);
}
