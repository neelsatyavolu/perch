/**
 * The approval card (spec 7.4, DESIGN.md): exactly what will be sent, and a confirm button that
 * names the action. Only the button's text turns danger for payments and deletions.
 */

import { useState } from "preact/hooks";
import type { ApprovalCard as Card } from "../api/types";

const KIND_WORDS: Record<Card["kind"], string> = {
  change: "Changes the page",
  risky: "Sends, posts or deletes",
  payment: "Payment or password, always asks",
};

type Login = { username: string; password: string };

export function ApprovalCard({ card, onDecide }: { card: Card; onDecide: (approved: boolean, login?: Login) => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  // A sign-in card with nothing saved asks for the login here. It stays in this card only, goes
  // with the answer to fill the page, and is cleared at once; the agent never sees it.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const decide = async (approved: boolean) => {
    if (busy) return;
    setBusy(true);
    const login = approved && card.login ? { username, password } : undefined;
    setPassword("");
    try {
      await onDecide(approved, login);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="approve" aria-label="Approval needed" data-kind={card.kind}>
      <div class="ah">{card.title}</div>
      <div class="meta">
        <span class="mono">{card.site}</span> · {KIND_WORDS[card.kind]}
      </div>
      {card.body !== undefined && <blockquote class="body">{card.body || "(nothing)"}</blockquote>}
      {card.fields?.length ? (
        <dl class="fields">
          {card.fields.map((f, i) => (
            <div key={i}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {card.login && (
        <form class="login" onSubmit={(e) => { e.preventDefault(); if (password) void decide(true); }}>
          <label>
            <span>Username or email</span>
            <input type="text" autocomplete="username" spellcheck={false} value={username} onInput={(e) => setUsername(e.currentTarget.value)} />
          </label>
          <label>
            <span>Password</span>
            <input type="password" autocomplete="current-password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
          </label>
          <p class="note">Nothing is saved for {card.site}. Perch types this into the page; the agent never sees it.</p>
        </form>
      )}
      <div class="act">
        <button type="button" class={card.danger ? "btn small primary danger" : "btn small primary"} disabled={busy || (card.login !== undefined && !password)} onClick={() => void decide(true)}>
          {card.confirm}
        </button>
        <button type="button" class="btn small outline" disabled={busy} onClick={() => void decide(false)}>
          Don’t allow
        </button>
      </div>
    </section>
  );
}
