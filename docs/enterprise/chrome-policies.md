# Chrome policies in Perch

Perch is Chromium, so the standard Chrome enterprise policies work unchanged. Set them in a
configuration profile whose payload type is `co.xanom.perch` (Perch's bundle id), the same way you
set them for `com.google.Chrome`. You can put Chrome policies and [Perch's own policies](policies.md)
in the same payload. `perch://policy` lists every policy Perch received and where it came from.

Only forced (managed) values count as mandatory. A value a user sets with
`defaults write co.xanom.perch …` is treated as recommended, as in Chrome, and Perch ignores it for
its own policies.

## Policies Perch ignores

Some Chrome policies control Google services Perch does not include. Perch blocks them wherever they
come from, so nothing applies them, and `perch://policy` marks them with Chromium's own status "This
policy is blocked, its value will be ignored.":

| Policy | Why |
|---|---|
| `BrowserSignin` | Perch has no Google sign-in |
| `CloudManagementEnrollmentToken` | Perch has no Chrome Enterprise Core enrollment |
| `MetricsReportingEnabled` | Perch sends no Chrome usage statistics |

`SyncDisabled` is not on this list. Perch's browser sync runs on Chromium's sync engine against
Perch's own server, so `SyncDisabled` set to true turns Perch's sync off, the same as the Perch
policy `SyncEnabled` set to false.

## Certificates

Perch uses the macOS trust store. Company root certificates installed in the System keychain by a
profile work without any Perch setting. `CACertificates` and `CAPlatformIntegrationEnabled` are
available when you need them. `CACertificates` takes a list of base64-encoded DER certificates, as in
Chrome.

## Recommended alongside your policies

Set `PolicyTestPageEnabled` to false. Chromium lets a person load local test policies at the next
start (the policy test page writes them into the profile's `Local State`), and test policies
replace every other policy source while they are active. Release builds of Perch turn the test page
off; this policy also stops test policies from loading.

## What has been checked

`perchd/scripts/policy-check.ts` sets each policy below on a dev build of Perch, using Chromium's
local test policies in a throwaway profile, runs Perch headless and looks for the effect. Run it
with:

```sh
cd perchd
bun run scripts/policy-check.ts --app /path/to/out/Dev/Perch.app
```

It rewrites the table below. A result of "fails" is a bug to fix before a release, or a policy to
move to the ignored list with the reason.

Three limits of this check:

- Chromium treats some policies as sensitive (the homepage and startup pages, metrics reporting
  and a few others) and takes them only from a managed Mac, never from test policies. The check
  shows these as blocked; whether they apply is part of the owner's check with a real profile.
- The "Ignored in Perch" status comes from a Chromium patch (plan 8, task 2). A dev build without
  that patch reports `BrowserSignin` and `CloudManagementEnrollmentToken` as applied, which the
  table shows as not matching what is expected.
- For `CACertificates` the check sets a fixed test root (its private key was thrown away) and reads
  the policy page, which shows whether Chromium took the certificate. It does not yet load a page
  signed by that root. The table below is from a run before the `CACertificates` case was added;
  the next run adds its row.

<!-- policy-check:begin -->
Checked 2026-11-07 on Chromium 158.0.8127.18.

| Policy | Result | How it was checked | Detail |
|---|---|---|---|
| URLBlocklist, URLAllowlist | works | navigation blocked except the allowed path | blocked page: net::ERR_BLOCKED_BY_ADMINISTRATOR; allowed page: loaded |
| HomepageLocation, RestoreOnStartup, RestoreOnStartupURLs | blocked in test policies; needs a managed Mac | status on the policy page | HomepageLocation: This policy is blocked, its value will be ignored.; RestoreOnStartup: This policy is blocked, its value will be ignored.; RestoreOnStartupURLs: This policy is blocked, its value will be ignored. |
| IncognitoModeAvailability | works | status on the policy page | IncognitoModeAvailability: applied |
| ExtensionInstallBlocklist, ExtensionInstallAllowlist, ExtensionInstallForcelist | works | status on the policy page | ExtensionInstallBlocklist: applied; ExtensionInstallAllowlist: applied; ExtensionInstallForcelist: applied |
| DownloadRestrictions | works | download refused | 0 file(s) saved with the policy, 1 without it |
| ProxySettings | works | request seen by a local proxy | the check's proxy received the request for perch-policy-check.example |
| SafeBrowsingProtectionLevel | works | status on the policy page | SafeBrowsingProtectionLevel: applied |
| ComponentUpdatesEnabled | works | status on the policy page | ComponentUpdatesEnabled: applied |
| CAPlatformIntegrationEnabled | works | status on the policy page | CAPlatformIntegrationEnabled: applied |
| BrowserSignin | ignored | status on the policy page | BrowserSignin: ignored in Perch |
| CloudManagementEnrollmentToken | ignored | status on the policy page | CloudManagementEnrollmentToken: ignored in Perch |
| MetricsReportingEnabled | ignored | status on the policy page | MetricsReportingEnabled: ignored in Perch |
| AgentEnabled | works | status on the policy page | AgentEnabled: applied |
<!-- policy-check:end -->
