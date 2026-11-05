/**
 * The page a sign-in link opens. The token is in the URL fragment, so it never reaches the server
 * until the person acts. The page asks them to type the number their device shows. Blackletter
 * styling (DESIGN.md): near-black canvas, one blue accent, hairlines, 8px radii, no web fonts.
 */
export function confirmPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Sign in to Perch</title>
<style nonce="${nonce}">
:root { --canvas:#0B0B0C; --surface:#141416; --line:#26262A; --text:#F2F2F3; --muted:#9A9AA2; --accent:#4C8DFF; --danger:#FF6B6B; }
@media (prefers-color-scheme: light) { :root { --canvas:#FAFAF9; --surface:#FFFFFF; --line:#E4E4E7; --text:#111113; --muted:#5F5F67; } }
* { box-sizing:border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--canvas); color:var(--text);
  font:15px/1.5 Geist, -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
main { width:100%; max-width:400px; background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:32px; }
h1 { font:500 24px/1.25 "Geist Serif", Georgia, serif; margin:0 0 8px; }
p { margin:0 0 16px; color:var(--muted); }
form { display:flex; gap:8px; }
input { flex:1; min-width:0; height:56px; border-radius:8px; border:1px solid var(--line); background:transparent; color:var(--text);
  padding:0 16px; font:500 20px "Geist Mono", ui-monospace, Menlo, monospace; letter-spacing:0.1em; }
input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
button { height:56px; padding:0 20px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:#fff;
  font:500 15px Geist, -apple-system, BlinkMacSystemFont, sans-serif; cursor:pointer; }
button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.error { color:var(--danger); }
</style>
</head>
<body>
<main>
  <h1>Sign in to Perch</h1>
  <p id="message">Checking the link…</p>
  <form id="form" hidden>
    <input id="number" inputmode="numeric" pattern="[0-9]{2}" maxlength="2" autocomplete="off" aria-label="Number shown in Perch" required>
    <button type="submit">Sign in</button>
  </form>
</main>
<script nonce="${nonce}">
(() => {
  const token = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  const message = document.getElementById("message");
  const form = document.getElementById("form");
  const input = document.getElementById("number");
  const say = (text, isError) => { message.textContent = text; message.className = isError ? "error" : ""; };
  const post = async (path, body) => {
    const response = await fetch("/v1/auth/email/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((data.error && data.error.message) || "Something went wrong. Start again in Perch.");
    return data;
  };
  const send = async (match) => {
    form.hidden = true;
    try {
      const data = await post("confirm", { token, match });
      say("Signed in on " + data.deviceName + ". You can close this tab and go back to Perch.");
    } catch (error) { say(error.message, true); }
  };
  if (!token) { say("This link is incomplete. Open the whole link from the email.", true); return; }
  post("confirm/info", { token }).then((data) => {
    say("Type the number Perch shows on " + data.deviceName + ". A wrong number cancels this sign-in. If you did not ask to sign in, close this tab.");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const match = Number(input.value.trim());
      if (Number.isInteger(match) && match >= 10 && match <= 99) send(match);
      else say("Type the two-digit number Perch shows.", true);
    });
    form.hidden = false;
    input.focus();
  }).catch((error) => say(error.message, true));
})();
</script>
</body>
</html>`;
}
