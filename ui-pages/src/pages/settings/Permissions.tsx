import { useState } from "preact/hooks";
import type { PermissionMode, Permissions as P, SiteRuleKind } from "../../api";
import { MODES, SITE_RULES } from "../../lib/labels";
import { relativeTime } from "../../lib/time";
import { checkSitePattern } from "../../lib/validate";
import { MANAGED_NOTE } from "../../lib/managed";
import { useAction, useApi, useLoad } from "../../ui/frame";
import { useManaged } from "../../ui/useManaged";
import { Icon, Trash2 } from "../../ui/icons";
import { Group, Row } from "../../ui/Row";
import { focusSibling, nextIndex } from "../../ui/roving";
import { AuditLog } from "./AuditLog";

const ORDER: readonly PermissionMode[] = ["ask", "guard", "skip"];
const RULE_KINDS = Object.keys(SITE_RULES) as SiteRuleKind[];
/** Modes at or below the company cap (spec 12.2). */
const withinCap = (max: PermissionMode | null) => (m: PermissionMode) => max === null || ORDER.indexOf(m) <= ORDER.indexOf(max);

function ModePicker({ value, max, onChange }: { readonly value: PermissionMode; readonly max: PermissionMode | null; readonly onChange: (m: PermissionMode) => void }) {
  const allowed = withinCap(max);
  const options = ORDER.filter(allowed);
  return (
    <div class="card mode-list" role="radiogroup" aria-label="Default permission mode">
      {ORDER.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          class="mode-opt"
          aria-checked={m === value ? "true" : "false"}
          tabIndex={m === value ? 0 : -1}
          disabled={!allowed(m)}
          onClick={() => onChange(m)}
          onKeyDown={(e) => {
            const at = options.indexOf(m);
            const next = nextIndex(e.key, at, options.length);
            if (next === null) return;
            e.preventDefault();
            onChange(options[next]!);
            focusSibling(e.currentTarget, "[role=radio]:not(:disabled)", next);
          }}
        >
          <span class="radio" aria-hidden="true" />
          <span>
            <span class="n">{MODES[m].label}{m === "guard" ? " (recommended)" : ""}</span>
            <span class="d" style={{ display: "block" }}>{allowed(m) ? MODES[m].detail : "Turned off by your organization"}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function Permissions() {
  const api = useApi();
  const act = useAction();
  const perms = useLoad((a) => a.getPermissions());
  const { locked } = useManaged();
  const [pattern, setPattern] = useState("");
  const [rule, setRule] = useState<SiteRuleKind>("never");
  const [error, setError] = useState<string | null>(null);
  const p = perms.data;
  const apply = async (run: () => Promise<P>, done?: string) => {
    const next = await act(run, done);
    if (next) perms.set(next);
    return next;
  };
  const add = async () => {
    const c = checkSitePattern(pattern);
    if (!c.ok) return setError(c.error);
    setError(null);
    if (await apply(() => api.addSiteRule({ pattern: c.value, rule }), `Added a rule for ${c.value}`)) setPattern("");
  };
  if (!p) return <p class="mute">{perms.error ?? ""}</p>;

  return (
    <div class="sec">
      <Group label="Default mode for new chats" id="permission-mode">
        <ModePicker value={p.mode} max={p.maxMode} onChange={(m) => apply(() => api.setPermissionMode(m), `New chats use ${MODES[m].label}`)} />
        {(p.maxMode || locked("permission-mode")) && <p class="note">{MANAGED_NOTE}</p>}
        <p class="note">Each chat can change its own mode from the composer. Payments always wait for you, in every mode.</p>
      </Group>

      <Group label="Site rules" id="site-rules">
        <div class="card">
          {p.siteRules.length === 0 && <p class="empty">No site rules. The default mode applies everywhere.</p>}
          {p.siteRules.map((r) => (
            <Row key={r.id} title={<span class="mono">{r.pattern.replace(/^=/, "")}</span>} detail={r.pattern.startsWith("=") ? "Only this host" : undefined}>
              <select class="picker" aria-label={`Rule for ${r.pattern}`} value={r.rule} onChange={(e) => {
                const next = (e.currentTarget as HTMLSelectElement).value as SiteRuleKind;
                apply(() => api.addSiteRule({ pattern: r.pattern, rule: next }));
              }}>
                {RULE_KINDS.map((k) => <option key={k} value={k}>{SITE_RULES[k]}</option>)}
              </select>
              <button type="button" class="ib" aria-label={`Remove the rule for ${r.pattern}`} onClick={() => apply(() => api.removeSiteRule(r.id), `Removed the rule for ${r.pattern}`)}>
                <Icon of={Trash2} />
              </button>
            </Row>
          ))}
          <form class="add-rule" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <input class="field mono" aria-label="Site" placeholder="bank.com, *.example.com or =mail.example.com" value={pattern}
              aria-invalid={error ? "true" : undefined} aria-describedby={error ? "rule-err" : undefined}
              onInput={(e) => setPattern((e.currentTarget as HTMLInputElement).value)} />
            <select class="picker" aria-label="Rule" value={rule} onChange={(e) => setRule((e.currentTarget as HTMLSelectElement).value as SiteRuleKind)}>
              {RULE_KINDS.map((k) => <option key={k} value={k}>{SITE_RULES[k]}</option>)}
            </select>
            <button type="submit" class="btn">Add rule</button>
            {error && <p class="field-error" id="rule-err" role="alert">{error}</p>}
          </form>
        </div>
        <p class="note">"Never touch" stops the agent from reading or acting on a site, for example your bank.</p>
      </Group>

      <Group label="Outside agents" id="client-rules">
        <div class="card">
          {p.clientRules.map((c) => (
            <Row key={c.id} title={c.client} detail={c.lastUsed ? `Last used ${relativeTime(c.lastUsed).toLowerCase()}` : "Not used yet"}>
              <select class="picker" aria-label={`Mode for ${c.client}`} value={c.mode} onChange={(e) => {
                const mode = (e.currentTarget as HTMLSelectElement).value as PermissionMode;
                apply(() => api.setClientMode(c.id, mode));
              }}>
                {ORDER.filter(withinCap(p.maxMode)).map((m) => <option key={m} value={m}>{MODES[m].label}</option>)}
              </select>
            </Row>
          ))}
        </div>
        <p class="note">
          The perch command, each MCP client and remote control get their own mode. Guard is the default.
          {p.maxMode && ` Your organization allows up to ${MODES[p.maxMode].label}.`}
        </p>
        {locked("client-rules") && !p.maxMode && <p class="note">{MANAGED_NOTE}</p>}
      </Group>

      <AuditLog />
    </div>
  );
}
