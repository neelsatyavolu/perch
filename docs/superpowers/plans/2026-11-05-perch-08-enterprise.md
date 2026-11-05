# Perch plan 8: enterprise

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An IT team can deploy Perch with the tools it already uses for Chrome. Perch ships as a signed, notarized `.pkg` as well as the DMG. Chrome policies in a configuration profile for `co.xanom.perch` work unchanged, and a checked list says which ones do. Perch's own policies (spec 12.2) control the agent, models, memory, outside agents, remote control, sync, import, built-ins, telemetry and the audit log, and the user cannot lift them. `perch://policy` lists every active policy and where it came from, and Settings rows a policy controls are locked. A company can run its own sync server with sign-in through its identity provider (OpenID Connect) and revoke devices. Every release publishes an SBOM and checksums.

**Architecture:** One file, `enterprise/policies.json`, defines every Perch policy: name, type, schema, default, caption and description. Everything else is generated from it or tested against it:
- `perch-build` turns it into Chromium policy template YAML (an overlay directory) plus a generated step that gives each policy an id in `policies.yaml`. Chromium then loads, validates and displays Perch policies exactly like its own, so `chrome://policy` (shown as `perch://policy`) needs no new page.
- `perchd` reads the same names through CoreFoundation (`CFPreferencesCopyAppValue` and `CFPreferencesAppValueIsForced`, the calls Chromium's `PolicyLoaderMac` makes), so the browser and the daemon see the same values even when the browser is closed and remote control keeps `perchd` running. Only forced (MDM) values count as mandatory, as in Chromium.
- Enforcement lives in `perchd`, at the point where each feature starts (model catalogue, permission modes, client sign-in, relay, sync, import, memory, audit). Settings asks `perchd` which rows are managed.

Chrome policies need no reading code: for a non-Google build, `ChromeBrowserPolicyConnector` already watches the app's own bundle id (`base::apple::BaseBundleID()`), which is `co.xanom.perch`. The work there is a check, two small patches (close the test-policy bypass, mark Google-only policies as ignored), and docs.

The company sync server is plan 7's Worker with a `company` auth mode: OpenID Connect sign-in started by the device and finished in the browser, with the same poll-secret and typed-number protections the email flow has, plus admin routes to list and revoke devices.

**Tech Stack:** Python 3.12 (`perch-build`, pytest). TypeScript on Bun for `perchd` (`bun test`, `bun:ffi` against CoreFoundation, as `perchd/src/secure/mac-security.ts` already does). Chromium policy templates (YAML) and C++. Cloudflare Workers, Hono, D1 and vitest with `@cloudflare/vitest-plugin` for the server. `pkgbuild`, `productbuild`, `productsign`, `xcrun notarytool`. Chromium's `tools/licenses/licenses.py` for the SPDX SBOM. `osv-scanner` for the dependency check.

**Spec:** `docs/superpowers/specs/2026-11-02-perch-design.md` (sections 2 goal 10, 7.4 audit log, 11.1, 11.4, 12.1 to 12.4, 15 step 8). Roadmap: `docs/superpowers/plans/2026-11-03-perch-roadmap.md` (plan 8, needs 2, 4 and 7).

## Global Constraints

- Everything in plan 1's Global Constraints still applies: arm64 only, bundle id `co.xanom.perch`, secrets never printed, logged or committed, no GUI driving by agents, `type: description` commits with no attribution lines.
- The Chromium tree used while writing this plan is `/Users/Shared/chromium-perch.noindex/src` at `158.0.8127.18` (`PERCH_CHROMIUM_DIR=/Users/Shared/chromium-perch.noindex`). File paths below were checked in that tree. A rebase may move them; `perch-build apply` stops on the first patch that no longer applies.
- **No machine-wide writes by agents.** Agents never write `/Library/Managed Preferences`, never install a profile or a package, and never run `sudo`. Real MDM checks are owner steps. Agent checks use a dev build, a throwaway `--user-data-dir`, and Chromium's local test policies (task 3).
- An unmanaged Mac behaves exactly as before this plan: no new prompts, no new rows in Settings, no warnings in `perch://policy`, and no measurable start-up cost (policy reading is one CoreFoundation call per policy name, done off the start-up path in `perchd`).
- Perch policies are mandatory only. A value a user sets with `defaults write co.xanom.perch …` is not forced, so Chromium treats it as recommended and `perchd` ignores it for enforcement (Review Focus 1).
- The company server keeps the end-to-end design of spec 11.3: it stores ciphertext, sizes, timestamps and device ids. Admins see device names, kinds and dates, never data.
- Copy follows spec 6.6 and `~/ANTI AI WRITING.md`. The locked-row text is exactly `Managed by your organization`, which `ui-pages` already uses for `maxMode`.

## Review Focus

1. **A user lifting a company policy.** Four ways in, each closed and tested:
   - Chromium's `chrome://policy/test` page: `IsPolicyTestingEnabled` returns true for `Channel::DEFAULT`, which is Perch's channel, and when local test policies are active `PolicyServiceImpl` ignores every other provider. Task 2 turns the page off in official builds.
   - `defaults write` at user level: not forced, so not mandatory (task 4 test).
   - Settings or the bridge asking `perchd` for a value above the policy: refused in `perchd`, not only greyed out in the page (task 5 test).
   - An outside client asking for a higher mode, or connecting when `MCPServerEnabled` is false: refused at client sign-in and on every call (task 4 test).
2. **Policy changing while Perch runs.** New values apply within 30 seconds without a restart. A running chat whose mode is now above `MaxPermissionMode` drops to the cap before its next action; a relay connection closes when `RemoteControlEnabled` turns false; sync stops when `SyncEnabled` turns false. Tests in task 4.
3. **OpenID Connect sign-in.** `state`, `nonce` and PKCE (S256) are checked; the ID token's signature, `iss`, `aud`, `exp` and `iat` are checked; the admin claim is read only from a verified ID token; a sign-in link sent to someone else cannot hand their account to the sender's device (typed number, as plan 7's email flow). Tests in task 8.
4. **The audit log mirror (`AuditLogPath`).** It holds what the local audit log holds and nothing more: no filled values, no message text beyond what the approval card showed. An unwritable path is reported in `perch://policy` and Settings, and the local log keeps working. Log rotation by rename is followed. Tests in task 7.
5. **The `.pkg`.** It carries no Google updater, Keystone or brand-code scripts (Chromium's `chrome/installer/mac/pkg_postinstall.in` installs GoogleUpdater, so it is not used), installs only to `/Applications/Perch.app`, and is signed with a Developer ID Installer certificate and notarized. Tests in task 6.

---

## File structure

```
perch/
  enterprise/
    policies.json                     the policy catalogue (single source)
    chrome-policy-check.json          Chrome policies the check sets, and what it expects
    examples/perch-example.mobileconfig   generated from policies.json, for owners and IT
  overlay/
    chrome/browser/perch/OWNERS
    chrome/browser/perch/policy/perch_ignored_policy_handler.h
    chrome/browser/perch/policy/perch_ignored_policy_handler.cc
    chrome/browser/perch/perch_update_policy.{h,cc}   task 9's update rules, plus a unit test
    components/policy/resources/templates/policy_definitions/Perch/   generated YAML, committed
  patches/perch/policy/
    no-test-policies-in-release.patch
    ignored-google-policies.patch
  tools/perchtools/
    policies.py                       catalogue -> YAML, ids generator, docs, mobileconfig
    pkg.py                            pkgbuild, productbuild, productsign, notarize
    sbom.py                           SPDX from Chromium + lockfiles, checksums, osv-scanner
  perchd/src/policy/
    cfprefs.ts                        bun:ffi CFPreferences reader, CF -> JSON values
    catalogue.ts                      loads enterprise/policies.json (bundled at build)
    policy.ts                         Policy type, validate(), effective helpers
    watch.ts                          reload every 30 s and on change; emits "policy"
  perchd/src/agent/audit.ts           (modify) one log, read(), export, mirror
  perchd/scripts/policy-check.ts      task 3's Chrome policy check
  server/migrations/0004_company.sql
  server/src/auth/oidc.ts  server/src/auth/jwt.ts  server/src/admin.ts
  ui-pages/src/lib/managed.ts         which Settings rows each policy locks
  docs/enterprise/{deploying,policies,chrome-policies,company-server}.md
  SECURITY.md
```

---

### Task 1: The policy catalogue and its generators

**Files:**
- Create: `enterprise/policies.json`, `tools/perchtools/policies.py`, `overlay/chrome/browser/perch/OWNERS`
- Modify: `tools/perchtools/cli.py` (add `policies generate|check`, and register the `policy ids` generator for `apply`)
- Test: `tests/test_policies.py`

**Interfaces:**
- Consumes: plan 1's `Generator` type and `apply_series`.
- Produces:
  - `Policy(name: str, type: Literal["boolean","integer","string","list","dict"], schema: dict, default: object, caption: str, desc: str, example: object, dynamic: bool = True)` (frozen dataclass), and `load_catalogue(path: Path) -> list[Policy]`, which raises `CatalogueError` on a duplicate name, a name that is not `[A-Z][A-Za-z0-9]+`, a default that fails its own schema, or an example that fails its schema.
  - `template_yaml(p: Policy, since: int) -> str`: one Chromium policy definition. `supported_on: [chrome.*:<since>-]`, `features: {dynamic_refresh: true, per_profile: false, can_be_recommended: false}`, `owners: [file://chrome/browser/perch/OWNERS]`, `tags: []`, `type: main`, plus `items` for booleans and string enums.
  - `group_details_yaml() -> str`: caption `Perch` and a one-line description.
  - `assign_ids(policies_yaml: str, names: Sequence[str]) -> str`: returns `policies.yaml` with each Perch name added under `policies:` with the next free ids after the highest existing one, and leaves the `atomic_groups:` section alone. Idempotent: names already present keep their ids.
  - `mobileconfig(policies: Sequence[Policy], values: Mapping[str, object]) -> bytes`: a configuration profile with one payload whose `PayloadType` is `co.xanom.perch` (the form Chrome's own docs use), with UUIDs from `uuid5` so the file is stable between runs.
  - `policies_md(policies) -> str`: the table in `docs/enterprise/policies.md`.

The catalogue holds the spec 12.2 table plus the spec 12.1 update controls:

| Policy | Type | Default | Notes |
|---|---|---|---|
| `AgentEnabled` | boolean | true | |
| `AllowedModelProviders` | list of string | all | values from `perchd/src/models/providers.ts` ids |
| `AllowedModels` | list of string | all | `provider/model` ids |
| `ModelEndpoints` | list of dict | none | `{name, kind: "openai"|"anthropic", url: https, keyRef?: "keychain:<service>/<account>"}` |
| `MaxPermissionMode` | string enum `ask`, `guard`, `skip` | `skip` | |
| `AgentSiteRules` | list of dict | none | `{pattern, rule: "never"|"ask"}` |
| `MemoryEnabled`, `HistoryExtractionEnabled` | boolean | true, true | |
| `MCPServerEnabled` | boolean | true | |
| `AllowedMCPClients` | list of string | all | client names as in `perchd/src/daemon/clients.ts` |
| `RemoteControlEnabled` | boolean | true | |
| `SyncEnabled` | boolean | true | |
| `SyncServerURL` | string | Perch's server | https only |
| `ImportEnabled` | dict | all | `{browsers: [...], data: [...]}` |
| `BuiltInExtensions` | dict | both on | `{backrow: bool, memorySaver: bool}` |
| `TelemetryEnabled` | boolean | false | can only be forced off; true is treated as unset |
| `AuditLogPath` | string | none | absolute, or starting with `~/`; `${USER}` allowed |
| `AutoUpdateEnabled` | boolean | true | spec 12.1 |
| `UpdateChannel` | string enum `stable`, `beta` | `stable` | spec 12.1 |
| `UpdateDelayDays` | integer 0 to 30 | 0 | spec 12.1 |
| `MinimumVersion` | string `x.y.z` | none | spec 12.1 |

`keyRef` names a Keychain item the MDM installs; a company key never sits in the profile. **[builder call]**

Ids: Perch has no cloud policy (no Device Management server), so ids are never stored or sent. They only need to be unique in each build, which is why a generator assigns them at apply time instead of a patch: a Chromium rebase that adds policies never conflicts. The highest id in `components/policy/resources/templates/policies.yaml` on `158.0.8127.18` is 1496.

- [ ] **Step 1: Write the failing tests**

```python
def test_catalogue_loads_every_spec_policy():
    names = {p.name for p in load_catalogue(REPO / "enterprise/policies.json")}
    assert {"AgentEnabled", "MaxPermissionMode", "AuditLogPath", "SyncServerURL", "UpdateDelayDays"} <= names
def test_catalogue_rejects_duplicates(tmp_path): ...       # CatalogueError naming the policy
def test_catalogue_rejects_bad_default(tmp_path): ...      # default "loud" for MaxPermissionMode fails
def test_template_yaml_boolean():
    y = yaml_load(template_yaml(AGENT_ENABLED, 158))
    assert y["supported_on"] == ["chrome.*:158-"] and y["features"]["can_be_recommended"] is False
    assert [i["value"] for i in y["items"]] == [True, False]
def test_assign_ids_appends_after_highest():
    out = assign_ids("policies:\n  1: HomepageLocation\n  1496: Last\natomic_groups:\n  1: Group\n", ["AgentEnabled", "MemoryEnabled"])
    assert "  1497: AgentEnabled\n  1498: MemoryEnabled\natomic_groups:" in out
def test_assign_ids_is_idempotent(): ...                   # running twice changes nothing
def test_mobileconfig_is_stable_and_valid(): ...           # plistlib loads it; two runs give equal bytes; PayloadType co.xanom.perch
def test_generated_overlay_matches_catalogue(): ...        # committed YAML files equal template_yaml() output, one per policy
```

- [ ] **Step 2: Run them and confirm they fail.** `uv run pytest tests/test_policies.py -q`
- [ ] **Step 3: Implement.** `perch-build policies generate` writes the overlay YAML, `.group.details.yaml`, `docs/enterprise/policies.md` and `enterprise/examples/perch-example.mobileconfig` (example values: agent on, `MaxPermissionMode` `guard`, `RemoteControlEnabled` false). `perch-build policies check` exits 1 when any generated file is stale, and CI runs it. Register `("policy ids", lambda src: …assign_ids…)` in the generators list so `apply` commits it as `perch-generated: policy ids`. The YAML's `owners` field needs a path inside the Chromium tree, so the overlay adds `chrome/browser/perch/OWNERS` with the single line `# Perch maintainers: github.com/neelsatyavolu/perch`.
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: add the Perch policy catalogue and its generators"`

### Task 2: Chromium: Perch policies, the test-policy bypass, Google-only policies, `perch://policy`

**Files:**
- Create: `patches/perch/policy/no-test-policies-in-release.patch`, `patches/perch/policy/ignored-google-policies.patch`, `overlay/chrome/browser/perch/policy/perch_ignored_policy_handler.{h,cc}`
- Modify: `patches/series`
- Chromium files patched: `components/policy/core/common/policy_utils.cc`, `chrome/browser/policy/configuration_policy_handler_list_factory.cc`, `components/policy_strings.grdp`, and the `BUILD.gn` that lists the handler list factory's sources

**Interfaces:**
- Consumes: task 1's overlay YAML and ids generator. Plan 2's `perch://` scheme alias, which maps `perch://<host>` to `chrome://<host>` for WebUI hosts, and its theme tokens for WebUI pages.
- Produces: Perch policies in Chromium's policy schema (so `chrome://policy` lists them under "Perch" and validates them), a closed test-policy path in official builds, and an "Ignored in Perch" status on Google-only policies.

What each patch does:
1. `no-test-policies-in-release.patch`. In `IsPolicyTestingEnabled` (`components/policy/core/common/policy_utils.cc`), return false when `OFFICIAL_BUILD` is defined, before the channel check. Why: Perch is unbranded, so its channel is `Channel::DEFAULT`, which turns the test page on; and when local test policies are active, `PolicyServiceImpl` (`components/policy/core/common/policy_service_impl.cc`, the `local_test_policy_provider_` branch) uses them instead of every other provider, which would let a user replace the company's policies. Dev builds keep the page, which task 3 relies on.
2. `ignored-google-policies.patch`. Add `PerchIgnoredPolicyHandler` to the handler list in `configuration_policy_handler_list_factory.cc`. For each name in its list it adds the error string `IDS_POLICY_PERCH_IGNORED` ("Perch ignores this policy. It controls a Google service Perch does not include."), added to `components/policy_strings.grdp` next to `IDS_POLICY_BLOCKED`. The list starts with `BrowserSignin`, `CloudManagementEnrollmentToken` and `MetricsReportingEnabled`, all present in `policies.yaml` on 158; task 3 settles the rest. `SyncDisabled` is not on the list: Perch's browser sync runs on Chromium's sync engine, so `SyncDisabled` true turns Perch sync off, and `perchd` treats it like `SyncEnabled` false. **[builder call]**
3. No patch for reading: `ChromeBrowserPolicyConnector` (`chrome/browser/policy/chrome_browser_policy_connector.cc`) uses `base::apple::BaseBundleID()` for non-Google brands, and `PolicyLoaderMac` (`components/policy/core/common/policy_loader_mac.mm`) reads forced values as mandatory and watches `/Library/Managed Preferences/<login>/co.xanom.perch.plist`.
4. `perch://policy` is Chromium's own policy page (`chrome/browser/ui/webui/policy/policy_ui.cc`, page code in `components/policy/resources/webui/`) reached through plan 2's scheme alias and themed by plan 2's WebUI tokens. If plan 2 themes WebUI pages by host list, add `policy` to that list; no policy-page patch otherwise.

- [ ] **Step 1: Make the changes in `src`,** commit each as its patch path, run `perch-build export`, and add both to `series` after the branding patches.
- [ ] **Step 2: Dev build.** `uv run perch-build build --config dev`. Success means the policy code generator accepts the Perch YAML (a schema or id error stops the build here) and nothing new warns.
- [ ] **Step 3: Headless check of the schema.** Run task 3's script with only `AgentEnabled: false` set. Success means `perch://policy` reports `AgentEnabled` with status OK, not "Unknown policy".
- [ ] **Step 4: Official-build check of patch 1** is part of task 10's release build: `strings` cannot prove it, so the release acceptance opens `chrome://policy/test` and expects the page to be unavailable.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: register Perch policies in Chromium, close the test-policy bypass, mark Google-only policies"`

### Task 3: Chrome policy check

**Files:**
- Create: `enterprise/chrome-policy-check.json`, `perchd/scripts/policy-check.ts`, `docs/enterprise/chrome-policies.md`
- Test: `perchd/test/policy-check.test.ts` (the parts that need no browser)

**Interfaces:**
- Consumes: `perchd`'s CDP pipe launcher from plan 3a, a dev build of Perch.
- Produces: `policyCheck({ app, cases, cdp }): Promise<CaseResult[]>` with `CaseResult = { policy: string; status: "works" | "ignored" | "fails"; detail: string }`, and the doc.

How it sets policies without touching the machine: it makes a temp `--user-data-dir`, writes `Local State` with `{"local_test_policies_for_next_startup": "<JSON list>"}` (the pref name is `policy_prefs::kLocalTestPoliciesForNextStartup`), and launches the dev build headless over `--remote-debugging-pipe`. Chromium loads those as mandatory machine policies on start. This only works in dev builds after task 2's patch, which is what we want.

Each case in `chrome-policy-check.json` sets one or more policies and names an effect `perchd` can observe through CDP. The cases cover the spec 12.2 list, all present in `policies.yaml` on 158:

| Policy | Value | Observed effect |
|---|---|---|
| `URLBlocklist` + `URLAllowlist` | block `example.com`, allow `example.com/ok` | navigation fails with `net::ERR_BLOCKED_BY_ADMINISTRATOR` except the allowed path |
| `HomepageLocation`, `RestoreOnStartup`, `RestoreOnStartupURLs` | `https://example.org/` | first tab's URL |
| `IncognitoModeAvailability` | 1 (disabled) | `Target.createBrowserContext` plus a new window is refused, or the incognito profile is unavailable |
| `ExtensionInstallBlocklist`, `ExtensionInstallAllowlist`, `ExtensionInstallForcelist` | `*` blocked, one id allowed and forced | the forced extension appears in `Target.getTargets` as a service worker |
| `DownloadRestrictions` | 3 (block all) | `Browser.downloadWillBegin` never fires and the download is cancelled |
| `ProxySettings` | fixed proxy at `127.0.0.1:<port>` the script listens on | the script's proxy sees the request |
| `SafeBrowsingProtectionLevel` | 0 | the policy page shows it applied |
| `ComponentUpdatesEnabled` | false | the policy page shows it applied |
| `BrowserSignin`, `CloudManagementEnrollmentToken`, `MetricsReportingEnabled` | any | the policy page shows "Ignored in Perch" |

For the "policy page shows" cases the script opens `perch://policy` and reads the row's status through `Runtime.evaluate`. Certificates: company roots in the System keychain work through the macOS trust store with no setup (spec 12.4). The check adds a case for `CACertificates` (a test root the script generates, then a page served with a certificate it signed loads without an interstitial) and one for `CAPlatformIntegrationEnabled` false (the page shows it applied). Both names are in `policies.yaml` on 158.

- [ ] **Step 1: Write the failing tests** for the parts that need no browser:

```ts
test("writes the test policies into Local State", async () => {
  const dir = await tempDir();
  await writeLocalState(dir, [{ name: "URLBlocklist", value: ["example.com"] }]);
  const state = JSON.parse(await Bun.file(`${dir}/Local State`).text());
  expect(JSON.parse(state.local_test_policies_for_next_startup)[0]).toMatchObject({ name: "URLBlocklist", level: 0, scope: 1, source: 0 });
});
test("refuses a release build", async () => { /* app whose Info.plist build is official -> throws "use a dev build" */ });
test("every case names a policy that exists in the pinned tree", () => { /* reads policies.yaml from PERCH_CHROMIUM_DIR when present, else skips */ });
```

- [ ] **Step 2: Run them and confirm they fail.** `cd perchd && bun test test/policy-check.test.ts`
- [ ] **Step 3: Implement the script.** `bun run scripts/policy-check.ts --app <dev Perch.app>` prints one line per case and writes the table into `docs/enterprise/chrome-policies.md` (policy, works or ignored, how it was checked, date, Chromium version). Fix the level, scope and source numbers against `LocalTestPolicyProvider::LoadJsonPolicies` in the tree before relying on them.
- [ ] **Step 4: Run it against the dev build.** Every case is `works` or the expected `ignored`. A `fails` is a bug to fix before task 10, or a policy to move to the ignored list with the reason in the doc.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "test: check Chrome policies against a dev build and document the results"`

### Task 4: `perchd` reads and enforces Perch policies

**Files:**
- Create: `perchd/src/policy/{cfprefs,catalogue,policy,watch}.ts`
- Modify: `perchd/src/models/catalog.ts` (filter), `perchd/src/agent/permissions.ts` and `perchd/src/daemon/clients.ts` (mode cap), `perchd/src/daemon/server.ts` (client gate), `perchd/src/agent/loop.ts` and `perchd/src/exec.ts` (agent gate, site rules), `perchd/src/sync/runner.ts` and `perchd/src/sync/api.ts` (base URL, on and off), `perchd/src/sync/relay-client.ts` (remote control), `perchd/src/import/` entry point, `perchd/src/memory/` extraction entry points, `perchd/src/daemon/daemon.ts` (start the watcher)
- Test: `perchd/test/policy.test.ts`, `perchd/test/policy-enforce.test.ts`

**Interfaces:**
- Produces:
  - `type PolicyValue = { name: string; value: unknown; forced: boolean }` and `interface PolicySource { read(names: readonly string[]): PolicyValue[] }`, with `cfPreferences(domain = "co.xanom.perch"): PolicySource` (bun:ffi: `CFPreferencesAppSynchronize`, `CFPreferencesCopyAppValue`, `CFPreferencesAppValueIsForced`, and a recursive CF-to-JSON converter keyed on `CFGetTypeID` for boolean, number, string, array and dictionary) and `fakeSource(values): PolicySource` for tests.
  - `type Policy` (one optional field per catalogue entry, typed) and `resolve(values: PolicyValue[], catalogue): { policy: Policy; errors: { name: string; message: string }[] }`. Only `forced` values count; a forced value that fails its schema is dropped and reported, never half-applied.
  - `class PolicyWatcher extends EventTarget` with `current(): Policy`, `errors()`, and a `"policy"` event. It reads at start, then every 30 seconds and when `fs.watch` on `/Library/Managed Preferences` fires, and emits only when the resolved policy changed.
  - Helpers the call sites use: `capMode(mode: Mode, policy): Mode`, `allowsModel(provider: string, model: string, policy): boolean`, `siteRuleFor(url: string, userRules, policy): SiteRule | undefined` (a policy rule wins over the user's for the same site; `never` cannot be loosened), `allowsClient(name: string, policy): boolean`, `syncBaseUrl(policy): string`, `importAllowed(browser, dataType, policy): boolean`.

Enforcement, each with a plain message the UI and clients show:

| Policy | Where | Message |
|---|---|---|
| `AgentEnabled` false | every chat run, `exec`, MCP `exec`, routines | "Your organization turned off the agent." |
| `AllowedModelProviders`, `AllowedModels` | catalogue listing and run start | the model is not listed; a run on a removed model stops with "Your organization doesn't allow this model." |
| `ModelEndpoints` | catalogue: adds company endpoints, and when set, hides personal sign-in providers | |
| `MaxPermissionMode` | `capMode` at chat start, before each action, and in `raisesMode` for clients | |
| `AgentSiteRules` | `needsApproval`'s site rule input | |
| `MemoryEnabled`, `HistoryExtractionEnabled` | extraction, dreaming and memory tools | |
| `MCPServerEnabled`, `AllowedMCPClients` | client sign-in and every request | "Your organization doesn't allow outside agents." |
| `RemoteControlEnabled` | relay connect, and disconnect on change | |
| `SyncEnabled`, `SyncDisabled` (Chrome), `SyncServerURL` | sync runner and `SyncApi` base URL | |
| `ImportEnabled` | import entry point per browser and data type | |
| `TelemetryEnabled` false | the opt-in ping | |
| `AuditLogPath` | task 7 | |

`BuiltInExtensions` and the update policies are read by the browser, not `perchd`.

- [ ] **Step 1: Write the failing tests**

```ts
test("only forced values count", () => {
  const { policy } = resolve([{ name: "AgentEnabled", value: false, forced: false }], CATALOGUE);
  expect(policy.AgentEnabled).toBeUndefined();
});
test("a forced value that fails its schema is dropped and reported", () => {
  const r = resolve([{ name: "MaxPermissionMode", value: "loud", forced: true }], CATALOGUE);
  expect(r.policy.MaxPermissionMode).toBeUndefined();
  expect(r.errors[0]).toMatchObject({ name: "MaxPermissionMode" });
});
test("catalogue names match enterprise/policies.json", () => { /* the bundled catalogue equals the repo file */ });
test("capMode clamps skip to guard", () => expect(capMode("skip", { MaxPermissionMode: "guard" })).toBe("guard"));
test("a client cannot raise its mode above the cap", async () => { /* clients.setMode("cli","skip") under cap guard rejects */ });
test("a policy never-rule beats a user allow-rule", () => { /* user allows bank.example, policy never -> "never" */ });
test("agent off stops a new run with the message", async () => { /* runner with fake model; first event is the error text */ });
test("a policy change caps a running chat before its next action", async () => { /* watcher emits; next action is asked */ });  // Review Focus 2
test("remote control off closes the relay", async () => { /* fake socket gets close */ });
test("MCP clients are refused when MCPServerEnabled is false", async () => { /* daemon.server with fake socket: 403 + message */ });
test("SyncServerURL must be https", () => { /* http URL is an error, Perch's default stays */ });
test("an unmanaged Mac changes nothing", () => { /* empty source: every helper returns the user's own setting */ });
```

- [ ] **Step 2: Run them and confirm they fail.** `cd perchd && bun test test/policy.test.ts test/policy-enforce.test.ts`
- [ ] **Step 3: Implement** the four modules and the call sites. The FFI reader runs only on macOS; on other hosts (CI) `cfPreferences()` returns no values. Add one test that runs only on macOS and reads a domain the test writes with `defaults write com.perch.policytest …` and deletes afterwards: the values come back with `forced: false`, which proves the reader without needing MDM.
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: perchd reads and enforces Perch policies"`

### Task 5: Locked Settings rows and the managed notice

**Files:**
- Create: `ui-pages/src/lib/managed.ts`
- Modify: `perchd/src/app/routes.ts` and the bridge method table (add `getPolicy`), `ui-pages/src/api.ts`, `ui-pages/src/api/rpc.ts`, `ui-pages/src/api/fake.ts`, the Settings sections that a policy controls (Permissions, Models, Memory, Sync, Developers → Remote Control and MCP, Import, Privacy, About)
- Test: `ui-pages/test/managed.test.ts`, `perchd/test/app-policy.test.ts`

**Interfaces:**
- Produces:
  - Bridge method `getPolicy(): Promise<{ managed: boolean; values: Record<string, unknown>; errors: { name: string; message: string }[] }>`.
  - `managedRows(policy): Set<RowId>` in `managed.ts`, mapping each policy to the Settings rows it locks.
  - Every Settings write method in `perchd` checks the policy first and fails with `{ error: "managed" }`, so the bridge cannot be used to step around a locked row (Review Focus 1).

A locked row shows its value, is disabled, and carries `Managed by your organization`. When anything is managed, Settings → About shows one extra row, "Your organization manages some settings", linking to `perch://policy`. Nothing changes on an unmanaged Mac.

- [ ] **Step 1: Write the failing tests:** each policy locks the rows in the table above; an unmanaged policy locks nothing; `setPermissionMode("skip")` under cap `guard` returns `managed` from `perchd`; `setMemoryEnabled(true)` under `MemoryEnabled: false` returns `managed`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Reuse the existing `maxMode` field in `Permissions` (it already renders the notice) and feed it from the policy.
- [ ] **Step 4: Run the tests, then the design review in spec 6.9** on the Settings pages with the fake API set to a managed policy (screenshots come from the `ui-pages` fake, not the owner's screen).
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: lock Settings rows a policy controls"`

### Task 6: The `.pkg`

**Files:**
- Create: `tools/perchtools/pkg.py`
- Modify: `tools/perchtools/package.py` (build the pkg after the DMG in release mode), `tools/perchtools/release.py` (upload it), `tools/perchtools/cli.py`, `docs/building.md`
- Test: `tests/test_pkg.py`

**Interfaces:**
- Consumes: the signed `Perch.app` from `package()`, `AppleCreds`, `run`.
- Produces:
  - `AppleCreds` gains `installer_identity: str` from `APPLE_INSTALLER_IDENTITY`; `creds_from_env` names it when missing, but only `package --mode release` requires it.
  - `component_plist(app_name: str) -> bytes`: `BundleIsRelocatable` false, `BundleIsVersionChecked` true, `BundleHasStrictIdentifier` true, `BundleOverwriteAction` `upgrade`.
  - `distribution_xml(info: VersionInfo) -> str`: title Perch, `hostArchitectures="arm64"`, `os-version min="27.0"`, one choice, `customize="never"`, no scripts.
  - `build_pkg(app: Path, dist: Path, info: VersionInfo, creds: AppleCreds, run=run) -> Path`.

`build_pkg` runs, in order:
1. `pkgbuild --root <dir holding only Perch.app> --component-plist <plist> --identifier co.xanom.perch.pkg --version <perch> --install-location /Applications <component.pkg>`
2. `productbuild --distribution <xml> --package-path <dir> <unsigned.pkg>`
3. `productsign --sign <installer_identity> --timestamp <unsigned.pkg> dist/Perch-<perch>.pkg`
4. `xcrun notarytool submit … --wait`, then `xcrun stapler staple` on the pkg
5. Verify: `pkgutil --check-signature`, `spctl -a -t install -vv`, `xcrun stapler validate`

Chromium's own pkg path (`chrome/installer/mac/signing/pipeline.py` with `Distribution(package_as_pkg=True)` in `model.py`) is not used, because its postinstall script installs GoogleUpdater and registers a brand code (Review Focus 5). **[builder call]**

**Owner action:** create a Developer ID Installer certificate in the Apple Developer account, store it in 1Password next to the application certificate, and extend `~/Documents/GitHub/agmux/scripts/load-apple-creds.sh` (or `scripts/maintainer.local`) to export `APPLE_INSTALLER_IDENTITY`.

- [ ] **Step 1: Write the failing tests**

```python
def test_component_plist_is_not_relocatable(): assert plistlib.loads(component_plist("Perch.app"))[0]["BundleIsRelocatable"] is False
def test_distribution_is_arm64_only(): assert 'hostArchitectures="arm64"' in distribution_xml(INFO)
def test_distribution_has_no_scripts(): assert "<script" not in distribution_xml(INFO) and "pkg-ref" in distribution_xml(INFO)
def test_build_pkg_order(tmp_path, recorder): ...   # pkgbuild, productbuild, productsign, notarytool, stapler staple, pkgutil, spctl, stapler validate
def test_build_pkg_never_logs_secrets(...): ...       # key id and issuer absent from stderr
def test_release_needs_installer_identity(): ...      # message names APPLE_INSTALLER_IDENTITY
def test_release_uploads_dmg_and_pkg(recorder): ...   # gh release create gets both files
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** and document `.pkg` installs in `docs/enterprise/deploying.md`: upload to Jamf, Kandji, Intune or Mosyle, deploy the profile from `enterprise/examples/`, and the update policies.
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: build a signed, notarized pkg for MDM"`

### Task 7: The audit log: one log, view, export and the company mirror

**Files:**
- Modify: `perchd/src/agent/audit.ts`, `perchd/src/app/main.ts`, `perchd/src/mcp.ts`, `perchd/src/cli.ts`, `perchd/src/app/routes.ts` and the bridge table (`listAuditLog`, `exportAuditLog`)
- Test: `perchd/test/audit.test.ts`

**Interfaces:**
- Consumes: plan 3a's `AuditEntry` and `AuditLog`, task 4's `PolicyWatcher`.
- Produces:
  - One log per profile. Today the sidebar, the MCP server and the dev CLI write three files (`audit.jsonl`, `mcp-audit.jsonl`, `dev-audit.jsonl`); they become one, so the log shows every client, as spec 7.4 asks. Old files are read once, merged by time, and removed.
  - `AuditLog.read({ limit, before }): Promise<AuditEntry[]>` (newest first) and `AuditLog.export(to: string, format: "jsonl" | "csv"): Promise<{ name: string; entries: number }>`. CSV cells that start with `=`, `+`, `-` or `@` get a leading `'`.
  - `AuditMirror(path: string)`: appends each entry as a JSON line to the `AuditLogPath` file. It expands `~` and `${USER}`, creates a missing parent with mode 0700, opens the file 0600, and reopens it when the path's inode changes (rotation by rename). On a write error it records the error for `getPolicy().errors` and Settings, keeps the local log, and retries every 60 seconds.
  - Bridge results match the types `ui-pages/src/api.ts` already declares (`AuditEntry` with `id`, `at`, `client`, `tab`, `site`, `action`, `outcome`), so the existing `AuditLog.tsx` page needs no change.

The mirror holds exactly the local entry. Filled values never reach either: plan 3a records a fill as "Filled the sign-in form". If plan 5 has moved the local log to per-record encryption by then (spec 11.1), the mirror is the only plain copy, and it exists only because the company asked for it. **[builder call]**

- [ ] **Step 1: Write the failing tests:** merging three old files keeps every entry once, in time order; `read` pages by `before`; CSV export guards formulas; the mirror creates its directory 0700 and file 0600; a rename of the mirror file is followed by a new file at the same path; an unwritable path reports an error and the local log still grows; no entry contains a value passed to a fill (property test over the fill tool's inputs).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: one audit log with export and the AuditLogPath mirror"`

### Task 8: Company sync server with OpenID Connect

**Files:**
- Create: `server/migrations/0004_company.sql`, `server/src/auth/oidc.ts`, `server/src/auth/jwt.ts`, `server/src/admin.ts`, `server/test/oidc.test.ts`, `server/test/admin.test.ts`, `server/test/fake-idp.ts`, `docs/enterprise/company-server.md`
- Modify: `server/src/env.ts`, `server/src/app.ts`, `server/src/ratelimit.ts` (rules), `server/src/auth/session.ts` (admin flag), `server/wrangler.jsonc` (vars, commented), `server/README.md`, `perchd/src/sync/api.ts` (`serverInfo`, `startOidc`, `pollOidc`)

**Interfaces:**
- `AppEnv` gains `AUTH_MODE?: "public" | "company"` (default `public`), `OIDC_ISSUER`, `OIDC_CLIENT_ID`, secret `OIDC_CLIENT_SECRET`, and `OIDC_ADMIN_GROUP` (a value of the ID token's `groups` claim). `Deps` gains `fetch` so tests serve a fake identity provider.
- Migration `0004_company.sql`: `identities (issuer TEXT, subject TEXT, account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE, PRIMARY KEY (issuer, subject))`; `oidc_requests (id, poll_hash, state_hash, nonce, verifier, match_number, device_name, device_kind, device_public_key, status, account_id, admin, created_at, expires_at)`; `sessions.admin INTEGER NOT NULL DEFAULT 0`.
- Routes:
  - `GET /v1/server` → `{ auth: ["oidc"] | ["email","passkey"], name }`, so `perchd` knows which sign-in to show for a `SyncServerURL`.
  - `POST /v1/auth/oidc/start {device}` → `{ requestId, pollSecret, matchNumber, url }`. `url` is `/v1/auth/oidc/go?r=<requestId>`.
  - `GET /v1/auth/oidc/go?r=` → a page that asks for the number Perch shows, then redirects to the provider's authorization endpoint with `state`, `nonce`, `code_challenge` (S256) and `scope=openid email profile groups`. A wrong number cancels the request, as plan 7's email link does.
  - `GET /v1/auth/oidc/callback?code&state` → exchanges the code (client secret, PKCE verifier), verifies the ID token, links `(iss, sub)` to an account (creating one on first sign-in; email is display only), marks the request approved, and shows "Perch is signed in. You can close this tab."
  - `POST /v1/auth/oidc/poll {requestId, pollSecret}` → the session once, then 410, exactly like the email poll.
  - `GET /v1/admin/devices` → every device with account email, name, kind, created, last seen and revoked; `DELETE /v1/admin/devices/:id` → revokes it, deletes its sessions and key copy, and closes its relay socket (plan 7's `disconnect`). Both need a browser session with `admin = 1` created in the last 12 hours.
- In company mode, `/v1/auth/email/*` and passkey registration answer 404; pairing still works, since it starts from a signed-in device.
- `verifyIdToken(token, { issuer, audience, nonce, jwks, now }): Promise<Claims>` in `jwt.ts`: RS256 and ES256 only, `kid` lookup with one JWKS refetch on a miss, 60-second clock skew. Discovery and JWKS are cached for an hour.

**[builder call]** The JWT check is written against WebCrypto (about 80 lines) instead of adding a library, because the server pins three dependencies today and the check is small and fully tested with a fake provider.

- [ ] **Step 1: Write the failing tests** (`fake-idp.ts` makes an RSA key with WebCrypto and serves discovery, JWKS and a token endpoint through `Deps.fetch`)

```ts
it("signs a device in through the identity provider and hands the session to that device once", ...);
it("refuses an ID token with the wrong nonce, audience, issuer, signature, or an expired one", ...);   // Review Focus 3
it("refuses a reused state and a callback for a request that is not waiting", ...);
it("cancels the request when the wrong number is typed, so a forwarded link cannot sign the sender in", ...);
it("refetches the JWKS once when the key id is new, and refuses an unknown key after that", ...);
it("marks the session admin only when the verified token has the admin group", ...);
it("lets an admin list and revoke devices, and closes the revoked device's relay socket", ...);
it("refuses admin routes to a non-admin, a CLI session, and an admin session older than 12 hours", ...);
it("turns email and passkey sign-up off in company mode and keeps them in public mode", ...);
it("keeps the same account when the user's email changes at the provider", ...);   // (iss, sub) is the key
```

- [ ] **Step 2: Run them one file at a time and confirm they fail.** `cd server && npx vitest run test/oidc.test.ts`
- [ ] **Step 3: Implement** the server side, then `SyncApi.serverInfo()`, `startOidc(device)` and `pollOidc(start)` in `perchd`, and the sign-in sheet branch that opens `url` in a Perch tab and shows `matchNumber`.
- [ ] **Step 4: Run the server tests file by file and `bun test` for the `perchd` sync client.**
- [ ] **Step 5: Write `docs/enterprise/company-server.md`:** deploy the Worker (`wrangler d1 create`, `wrangler deploy`), set `AUTH_MODE=company` and the three OIDC values, `wrangler secret put OIDC_CLIENT_SECRET`, register the redirect URI `https://<host>/v1/auth/oidc/callback` with the provider (Okta, Microsoft Entra ID and Google Workspace each get a short section naming where the groups claim is turned on), and set `SyncServerURL` in the profile. State plainly that the company server holds ciphertext only and admins cannot read synced data.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat: company sync server with OpenID Connect sign-in and device admin"`

### Task 9: Update control by policy

**Files:**
- Create: `overlay/chrome/browser/perch/perch_update_policy.{h,cc}` and `perch_update_policy_unittest.cc` (pure C++, so the rules are tested without Sparkle)
- Modify: `overlay/chrome/browser/perch/perch_updater_mac.mm`, `tools/perchtools/release.py` (`--channel beta`), `docs/rebasing.md`
- Test: `tests/test_release.py` (appcast channel), `perch_update_policy_unittest.cc`

**Interfaces:**
- Produces: `UpdatePolicy ReadUpdatePolicy()` (forced values only, read with `CFPreferencesAppValueIsForced`, as task 4 does), and `bool ShouldOffer(const UpdatePolicy&, base::Time published, const std::string& version, const std::string& channel)`.

Behaviour:
- `AutoUpdateEnabled` false: Sparkle's automatic checks are off and "Check for Updates…" is hidden.
- `UpdateChannel` `beta`: Sparkle's allowed channels include `beta`; `release.py --channel beta` writes `<sparkle:channel>beta</sparkle:channel>` on that item.
- `UpdateDelayDays` n: an item is offered only when its `pubDate` is at least n days old.
- `MinimumVersion` v: when the running version is lower, Perch checks for updates at launch and installs the update on quit, whatever the other settings say, unless `AutoUpdateEnabled` is false; then `perch://policy` shows the version gap.

- [ ] **Step 1: Write the failing tests** for `ShouldOffer` (delay, channel, minimum version) and for the beta appcast item.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement,** then a dev build (`perch-build build --config dev`) to confirm it compiles.
- [ ] **Step 4: Commit.** `git add -A && git commit -m "feat: control updates by policy"`

### Task 10: SBOM, checksums, `SECURITY.md`, release, owner acceptance

**Files:**
- Create: `tools/perchtools/sbom.py`, `SECURITY.md`
- Modify: `tools/perchtools/release.py` (preflight and assets), `tools/perchtools/cli.py` (`sbom`), `README.md` (link to `SECURITY.md` and `docs/enterprise/`)
- Test: `tests/test_sbom.py`, `tests/test_release.py`

**Interfaces:**
- Produces:
  - `chromium_spdx(paths: Paths, out: Path, run=run) -> Path`: runs `python3 tools/licenses/licenses.py --target-os mac --gn-out-dir out/Release --gn-target chrome license_file --format spdx --spdx-root <src> --spdx-link https://chromium.googlesource.com/chromium/src/+/<tag>/ --spdx-doc-name Perch-<perch>-chromium --spdx-doc-namespace https://github.com/neelsatyavolu/perch/releases/v<perch>/chromium.spdx <out>` in the Chromium tree. Those flags and the `license_file` subcommand exist in the pinned `licenses.py`.
  - `lockfile_packages(lockfiles: Sequence[Path]) -> list[Package]` for `perchd/bun.lock`, `ui/bun.lock` and `ui-pages/bun.lock` (only what ships in `Perch.app`), plus Sparkle from `build/sparkle.json`.
  - `merge_spdx(chromium: Path, packages, info) -> dict`: one SPDX 2.3 document, `Perch-<perch>.spdx.json`.
  - `checksums(files) -> str`: a `SHA256SUMS` file for the DMG, the pkg, the appcast and the SBOM.
  - `vulnerability_check(sbom: Path, run=run) -> list[str]`: runs `osv-scanner` on the SBOM and returns findings. The exact `osv-scanner` arguments are checked against `--help` of the version pinned in `docs/building.md` when this task starts.

`preflight` gains two refusals: a stale generated policy file (`perch-build policies check`), and any `osv-scanner` finding not listed in `docs/known-vulnerabilities.md` with a reason and date. `publish` uploads the DMG, the pkg, the appcast, the SBOM and `SHA256SUMS`, and the release notes link `docs/enterprise/chrome-policies.md`.

`SECURITY.md`: report privately to the address the owner gives (owner step), acknowledgement within 2 days, Chromium security fixes released within 72 hours of Google's stable release (spec 12.4), what is in scope (Perch's patches, `perchd`, the server, the extension) and what goes to Chromium upstream.

- [ ] **Step 1: Write the failing tests:** the SPDX document validates against the SPDX 2.3 JSON schema (vendored in `tests/fixtures/`), lists Perch as the root package with every lockfile package and Sparkle related to it, and carries the Chromium document's packages; `SHA256SUMS` lines match `shasum -a 256` output; preflight refuses a stale policy file and an unlisted vulnerability; `publish` uploads five files.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Release build and dry run.** Allow 3 to 4 hours for the build. `uv run perch-build build --config release && scripts/with-apple-creds.sh uv run perch-build package --mode release && scripts/with-apple-creds.sh uv run perch-build release --dry-run`. Success means `dist/release/` holds all five files, the pkg passes `spctl -a -t install`, and `osv-scanner` reports nothing unlisted.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat: publish an SBOM and checksums with each release, and add SECURITY.md"`
- [ ] **Step 7: Owner acceptance. The owner does this by hand, because it needs admin rights and the GUI:**
  - `sudo installer -pkg Perch-<v>.pkg -target /` installs to `/Applications/Perch.app`; `pkgutil --pkgs | grep co.xanom.perch` lists it.
  - Install `enterprise/examples/perch-example.mobileconfig` in System Settings → Privacy & Security → Profiles. `perch://policy` lists the Perch policies as Platform, Machine, Mandatory, and Settings → Permissions shows Guard locked with `Managed by your organization`.
  - With the profile installed, `defaults write co.xanom.perch MaxPermissionMode skip` does not unlock Skip.
  - `chrome://policy/test` is unavailable in the release build (task 2, patch 1).
  - Remove the profile; within 30 seconds the locks are gone and nothing else changed.
  - Optional, if the owner has an identity provider to hand (a free Okta developer org works): deploy the company server per `docs/enterprise/company-server.md`, point `SyncServerURL` at it, sign in, and revoke the device from the admin route.

---

## Spec coverage

| Spec item | Task |
|---|---|
| 2 goal 10: managed with the tools IT uses for Chrome | 2, 3, 4, 6 |
| 7.4 audit log viewable and exportable in Settings, every client | 7 |
| 11.1 secrets never in plain files or logs; least access | 4 (`keyRef`), 6 and 10 (redacted runs), 7 (mirror holds no secrets) |
| 11.1 dependencies checked for known vulnerabilities before each release | 10 |
| 11.4 self-host deploy of the same Worker | 8 (company mode on the same Worker) |
| 12.1 signed, notarized `.pkg` for MDM | 6 |
| 12.1 policies as configuration profiles for `co.xanom.perch` | 2 (no reader patch needed), 1 (example profile), 10 (owner check) |
| 12.1 update control: off, channel, delay, minimum version | 1 (catalogue), 9 |
| 12.2 Chrome policies work unchanged; Google-only ones ignored and listed | 2, 3 |
| 12.2 Perch policies table | 1, 4 |
| 12.2 `perch://policy` lists every policy and its source; locked Settings rows | 2, 5 |
| 12.3 company sync server with OpenID Connect, list and revoke devices, ciphertext only | 8 |
| 12.4 `SECURITY.md`, 72-hour security releases | 10 |
| 12.4 Chromium version, patch list, SBOM and checksums with each release | 10 (plan 1 already publishes the version and patch list) |
| 12.4 system trust store and company roots work without setup | 3 (checked and documented) |
| 15 step 8 | all |
| 16 no GUI driving, no secrets printed | Global Constraints, owner steps in 10 |
