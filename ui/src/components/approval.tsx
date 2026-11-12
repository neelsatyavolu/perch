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

export function ApprovalCard({ card, onDecide }: { card: Card; onDecide: (approved: boolean) => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const decide = async (approved: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await onDecide(approved);
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
      <div class="act">
        <button type="button" class={card.danger ? "btn small primary danger" : "btn small primary"} disabled={busy} onClick={() => void decide(true)}>
          {card.confirm}
        </button>
        <button type="button" class="btn small outline" disabled={busy} onClick={() => void decide(false)}>
          Don’t allow
        </button>
      </div>
    </section>
  );
}
