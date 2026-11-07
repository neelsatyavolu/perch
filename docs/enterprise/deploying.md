# Deploying Perch with MDM

Perch is managed the way Chrome is. If your MDM already pushes Chrome policies, it can push Perch's with the same kind of configuration profile, aimed at Perch's bundle id, `co.xanom.perch`.

## Installing Perch

Today Perch ships as a signed and notarized DMG, `Perch-<version>.dmg`, attached to each [GitHub release](https://github.com/neelsatyavolu/perch/releases). It holds `Perch.app`, which goes in `/Applications`. Jamf, Kandji, Intune and Mosyle can each install an app from a DMG; follow your tool's steps for a DMG app.

A signed and notarized `.pkg` installer is planned and not yet built. When it ships, it will be attached to each release next to the DMG and this page will cover it.

Each release also attaches an SBOM (`Perch-<version>.spdx.json`) and `SHA256SUMS`. To check a download, put it in a folder with `SHA256SUMS` and run `shasum -a 256 -c SHA256SUMS`. Files you did not download show as `FAILED open or read`; the ones you did should show `OK`.

## Setting policies

Policies arrive as a configuration profile with a custom settings payload for the preference domain `co.xanom.perch`. [`enterprise/examples/perch-example.mobileconfig`](../../enterprise/examples/perch-example.mobileconfig) is a working profile that keeps the agent on, caps the permission mode at Guard and turns remote control off. Use it as a starting point, or paste the keys into your MDM's custom settings for `co.xanom.perch`:

```xml
<key>AgentEnabled</key>
<true/>
<key>MaxPermissionMode</key>
<string>guard</string>
<key>RemoteControlEnabled</key>
<false/>
```

Two kinds of policy go in the same profile:

- **Perch policies** control the agent, models, memory, outside agents, remote control, sync, import, the built-in extensions, telemetry, the audit log and updates. Every one, with its type, default and an example, is in [policies.md](policies.md).
- **Chrome policies** work unchanged, under the same names Chrome uses. [chrome-policies.md](chrome-policies.md) lists which ones Perch supports and which Google-only ones it ignores.

Perch enforces a policy only when it comes from an installed profile. A value someone sets with `defaults write co.xanom.perch` is not enforced, so users cannot lift a policy that way. Changes to a profile reach a running Perch within 30 seconds, without a restart.

To see what is in force on a Mac, open `perch://policy`. It lists every active policy and where it came from. In Settings, a row a policy controls shows "Managed by your organization" and cannot be changed.

## Updates

Perch updates itself with Sparkle. Four policies control this:

| Policy | What it does |
|---|---|
| `AutoUpdateEnabled` | Set to false if you deploy new versions through your MDM instead |
| `UpdateChannel` | `stable` (the default) or `beta` |
| `UpdateDelayDays` | Offer an update only once it has been public for this many days, 0 to 30 |
| `MinimumVersion` | An older Perch checks for updates at launch and installs on quit |

Security releases follow Chromium's stable releases within 72 hours (see [SECURITY.md](../../SECURITY.md)). A long `UpdateDelayDays` holds those back too.

## Sync with your own server

By default sync goes to Perch's hosted server and is end-to-end encrypted. A company can run its own copy, with sign-in through its identity provider (OpenID Connect) and the ability to list and revoke devices, then point Perch at it with `SyncServerURL`. Setup is in [company-server.md](company-server.md). Set `SyncEnabled` to false to turn sync off instead.

## The agent audit log

Set `AuditLogPath` to have Perch append every agent audit entry as a JSON line to a file your security tools collect, for example `~/Library/Logs/Perch/audit-${USER}.jsonl`. The file holds what Perch's own audit log holds and nothing more.
