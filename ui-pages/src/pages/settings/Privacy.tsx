import { useState } from "preact/hooks";
import type { DohProvider, PrivacyPatch, PrivacySettings, SiteData } from "../../api";
import { formatBytes } from "../../lib/labels";
import { inlineTime } from "../../lib/time";
import { checkDohUrl } from "../../lib/validate";
import { useAction, useApi, useLoad } from "../../ui/frame";
import { Dialog } from "../../ui/Dialog";
import { Icon, X } from "../../ui/icons";
import { Group, Row } from "../../ui/Row";
import { Switch } from "../../ui/Switch";
import { BackupGroup } from "./Backup";

const DOH: Readonly<Record<DohProvider, string>> = { cloudflare: "Cloudflare", quad9: "Quad9", mullvad: "Mullvad", custom: "Custom" };

type Toggle = { id: string; key: keyof PrivacyPatch; title: string; detail: string };
const BLOCK_ADS: Toggle = { id: "content-blocker", key: "contentBlocker", title: "Block ads and trackers", detail: "EasyList and EasyPrivacy rules. Turn it off for one site from the address bar." };
const AD_TOGGLES: readonly Toggle[] = [
  { id: "cookie-banners", key: "cookieBanners", title: "Reject cookie banners", detail: "Clicks reject for you where the site offers it" },
  { id: "tracking-params", key: "trackingParams", title: "Remove tracking parameters", detail: "Strips utm_, fbclid, gclid and similar from links you open and copy" },
  { id: "fingerprinting", key: "fingerprinting", title: "Block fingerprinting", detail: "Adds a little noise, different on every site, to what canvas, WebGL and audio report, and turns off the ad-targeting APIs. Applies to tabs opened after you change it" },
];
const SEARCH_SUGGESTIONS: Toggle = { id: "search-suggestions", key: "searchSuggestions", title: "Search suggestions", detail: "Sends what you type in the address bar to your search engine as you type, to suggest searches" };
const HTTPS_ONLY: Toggle = { id: "https-only", key: "httpsOnly", title: "HTTPS-only", detail: "Asks before opening a site that only offers an unencrypted connection" };

function SiteDataCard() {
  const api = useApi();
  const act = useAction();
  const sites = useLoad((a) => a.listSiteData());
  const [forget, setForget] = useState<SiteData | null>(null);
  const list = sites.data ?? [];
  return (
    <Group label="Site data" id="site-data">
      <div class="card">
        {sites.data && list.length === 0 && <p class="empty">No sites have stored data.</p>}
        {list.map((s) => (
          <Row key={s.host} title={<span class="mono">{s.host}</span>} detail={`${formatBytes(s.bytes)} · ${s.cookies} cookies${s.lastUsed ? ` · used ${inlineTime(s.lastUsed)}` : ""}`}>
            <button type="button" class="btn" aria-label={`Forget ${s.host}`} onClick={() => setForget(s)}>Forget</button>
          </Row>
        ))}
      </div>
      <Dialog
        open={forget !== null}
        title={forget ? `Forget ${forget.host}?` : ""}
        onClose={() => setForget(null)}
        footer={forget && (
          <>
            <button type="button" class="btn" onClick={() => setForget(null)}>Cancel</button>
            <button type="button" class="btn primary" onClick={async () => {
              const host = forget.host;
              setForget(null);
              if (await act(() => api.forgetSite(host).then(() => true), `Forgot ${host}`)) sites.set(list.filter((x) => x.host !== host));
            }}>Forget site</button>
          </>
        )}
      >
        <p>This clears the site's cookies, storage and cache. You'll be signed out of it. History and bookmarks stay.</p>
      </Dialog>
    </Group>
  );
}

export function Privacy() {
  const api = useApi();
  const act = useAction();
  const privacy = useLoad((a) => a.getPrivacy());
  const [dohUrl, setDohUrl] = useState<string | null>(null);
  const [dohError, setDohError] = useState<string | null>(null);
  /** "Custom" picked in the menu but not saved yet: it is sent together with a valid address. */
  const [pendingCustom, setPendingCustom] = useState(false);
  const p = privacy.data;
  const apply = async (run: () => Promise<PrivacySettings>) => {
    const next = await act(run);
    if (next) privacy.set(next);
  };
  const patch = (x: PrivacyPatch) => apply(() => api.setPrivacy(x));
  if (!p) return <p class="mute">{privacy.error ?? ""}</p>;

  const saveDohUrl = async () => {
    const c = checkDohUrl(dohUrl ?? p.dohCustomUrl);
    if (!c.ok) return setDohError(c.error);
    setDohError(null);
    const next = await act(() => api.setPrivacy({ dohProvider: "custom", dohCustomUrl: c.value }), "Encrypted DNS uses your resolver");
    if (next) {
      privacy.set(next);
      setPendingCustom(false);
    }
  };
  const pickResolver = (d: DohProvider) => {
    setDohError(null);
    if (d === "custom") return setPendingCustom(true);
    setPendingCustom(false);
    patch({ dohProvider: d });
  };
  const resolver: DohProvider = pendingCustom ? "custom" : p.dohProvider;

  const toggle = (t: Toggle) => (
    <Row key={t.id} id={t.id} title={t.title} detail={t.detail}>
      <Switch label={t.title} describedBy={`${t.id}-d`} checked={Boolean(p[t.key])} onChange={(v) => patch({ [t.key]: v })} />
    </Row>
  );

  return (
    <div class="sec">
      <Group label="Ads and tracking">
        <div class="card">
          {toggle(BLOCK_ADS)}
          {p.blockerExceptions.map((host) => (
            <Row key={host} sub title={<span class="mono">{host}</span>} detail="Ads and trackers allowed on this site">
              <button type="button" class="ib" aria-label={`Block ads on ${host} again`} onClick={() => apply(() => api.removeBlockerException(host))}><Icon of={X} /></button>
            </Row>
          ))}
          {AD_TOGGLES.map(toggle)}
          <Row id="third-party-cookies" title="Block third-party cookies" detail="Sites can't follow you across other sites with cookies">
            <Switch label="Block third-party cookies" describedBy="third-party-cookies-d" checked={p.thirdPartyCookies === "block"} onChange={(v) => patch({ thirdPartyCookies: v ? "block" : "allow" })} />
          </Row>
        </div>
      </Group>

      <Group label="Connections">
        <div class="card">
          {toggle(HTTPS_ONLY)}
          {toggle(SEARCH_SUGGESTIONS)}
          <Row id="doh" title="Encrypted DNS" detail="Looks up site addresses over HTTPS, and falls back to your network's DNS if the resolver is unreachable">
            {p.dnsOverHttps && (
              <select class="picker" aria-label="DNS resolver" value={resolver} onChange={(e) => pickResolver((e.currentTarget as HTMLSelectElement).value as DohProvider)}>
                {(Object.keys(DOH) as DohProvider[]).map((d) => <option key={d} value={d}>{DOH[d]}</option>)}
              </select>
            )}
            <Switch label="Encrypted DNS" describedBy="doh-d" checked={p.dnsOverHttps} onChange={(v) => patch({ dnsOverHttps: v })} />
          </Row>
          {p.dnsOverHttps && resolver === "custom" && (
            <form class="add-rule" style={{ gridTemplateColumns: "1fr auto" }} onSubmit={(e) => { e.preventDefault(); saveDohUrl(); }}>
              {pendingCustom && <p class="note" style={{ gridColumn: "1 / -1" }}>Lookups keep using {DOH[p.dohProvider]} until you save an address.</p>}
              <input class="field mono" aria-label="Resolver address" placeholder="https://dns.example/dns-query" value={dohUrl ?? p.dohCustomUrl}
                aria-invalid={dohError ? "true" : undefined} onInput={(e) => setDohUrl((e.currentTarget as HTMLInputElement).value)} />
              <button type="submit" class="btn">Save</button>
              {dohError && <p class="field-error" role="alert">{dohError}</p>}
            </form>
          )}
        </div>
      </Group>

      <Group label="Background connections" id="background-connections">
        <div class="card">
          {p.backgroundConnections.map((c) => (
            <Row key={c.id} title={c.label} detail={c.detail}>
              <Switch label={c.label} checked={c.enabled} onChange={(v) => apply(() => api.setBackgroundConnection(c.id, v))} />
            </Row>
          ))}
        </div>
        <p class="note">These are the only connections Perch makes on its own. With all of them off, Perch connects only to the sites you open. Sync and remote control appear here when you turn them on.</p>
      </Group>

      <SiteDataCard />

      <BackupGroup />
    </div>
  );
}
