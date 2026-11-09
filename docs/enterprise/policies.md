# Perch policies

Generated from `enterprise/policies.json` by `perch-build policies generate`. Do not edit by hand.

Set these in a configuration profile for `co.xanom.perch`, the same way you set Chrome policies.
Perch enforces a value only when it comes from a profile your MDM installs.
A value set with `defaults write` does not count. `enterprise/examples/perch-example.mobileconfig` is a working example.

| Policy | Type | Default | What it controls |
|---|---|---|---|
| [`AgentEnabled`](#agentenabled) | boolean | `true` | Turn the agent on or off |
| [`AllowedModelProviders`](#allowedmodelproviders) | list | unset | Model providers users can connect |
| [`AllowedModels`](#allowedmodels) | list | unset | Models users can pick |
| [`ModelEndpoints`](#modelendpoints) | list | unset | Company model endpoints |
| [`MaxPermissionMode`](#maxpermissionmode) | string | `"skip"` | Highest permission mode |
| [`AgentSiteRules`](#agentsiterules) | list | unset | Sites the agent must never act on or must always ask on |
| [`MemoryEnabled`](#memoryenabled) | boolean | `true` | Turn memory on or off |
| [`HistoryExtractionEnabled`](#historyextractionenabled) | boolean | `true` | Let browsing history feed memory |
| [`MCPServerEnabled`](#mcpserverenabled) | boolean | `true` | Let outside agents connect |
| [`AllowedMCPClients`](#allowedmcpclients) | list | unset | Outside agents that can connect |
| [`RemoteControlEnabled`](#remotecontrolenabled) | boolean | `true` | Allow remote control |
| [`SyncEnabled`](#syncenabled) | boolean | `true` | Turn sync on or off |
| [`SyncServerURL`](#syncserverurl) | string | `"https://api.perchbrowser.com"` | Sync server |
| [`ImportEnabled`](#importenabled) | dict | unset | Browsers and data users can import |
| [`BuiltInExtensions`](#builtinextensions) | dict | `{"backrow": true, "memorySaver": true}` | Built-in extensions |
| [`TelemetryEnabled`](#telemetryenabled) | boolean | `false` | Allow the anonymous daily ping |
| [`AuditLogPath`](#auditlogpath) | string | unset | Copy the agent audit log to a file |
| [`AutoUpdateEnabled`](#autoupdateenabled) | boolean | `true` | Update automatically |
| [`UpdateChannel`](#updatechannel) | string | `"stable"` | Update channel |
| [`UpdateDelayDays`](#updatedelaydays) | integer | `0` | Delay updates by days |
| [`MinimumVersion`](#minimumversion) | string | unset | Minimum Perch version |

## AgentEnabled

When true or unset, the agent works as usual. When false, the agent cannot run: the sidebar chat, the perch CLI's exec command, the MCP server's exec tool and routines all stop with "Your organization turned off the agent." Browsing is not affected.

Type: boolean. Default: `true`.

Example:

```json
false
```

## AllowedModelProviders

The providers Settings > Models offers. Providers not listed are hidden, and a chat on one of their models stops. When unset, every provider is allowed.

Type: list. Default: unset.

Example:

```json
[
  "anthropic",
  "openai"
]
```

## AllowedModels

Model ids in the form provider/model, for example anthropic/claude-sonnet-5-5. Models not listed are hidden, and a chat on one stops with "Your organization doesn't allow this model." When unset, every model of an allowed provider is allowed.

Type: list. Default: unset.

Example:

```json
[
  "anthropic/claude-sonnet-5-5",
  "openai/gpt-6.1-sol"
]
```

## ModelEndpoints

Model endpoints the company runs, OpenAI-compatible or Anthropic-compatible, over https. keyRef names a Keychain item the MDM installs, as keychain:<service>/<account>; the key itself never goes in the profile. When set, these endpoints replace personal sign-in.

Type: list. Default: unset.

Example:

```json
[
  {
    "name": "Company models",
    "kind": "openai",
    "url": "https://models.example.com/v1",
    "keyRef": "keychain:com.example.models/perch"
  }
]
```

## MaxPermissionMode

The highest mode users and outside clients can choose: ask, guard or skip. A chat or client set higher drops to this mode before its next action.

Type: string. Default: `"skip"`.

Example:

```json
"guard"
```

## AgentSiteRules

Each rule has a site pattern (a host such as bank.example, which also covers its subdomains) and never or ask. A policy rule wins over the user's own rule for the same site, and a never rule cannot be loosened.

Type: list. Default: unset.

Example:

```json
[
  {
    "pattern": "bank.example",
    "rule": "never"
  },
  {
    "pattern": "hr.example.com",
    "rule": "ask"
  }
]
```

## MemoryEnabled

When true or unset, memory works as usual. When false, Perch does not pull facts out of chats or browsing, the nightly pass does not run, and the agent's memory tools are unavailable.

Type: boolean. Default: `true`.

Example:

```json
false
```

## HistoryExtractionEnabled

When true or unset, memory can learn from browsing history as well as chats. When false, it learns from chats only.

Type: boolean. Default: `true`.

Example:

```json
false
```

## MCPServerEnabled

When true or unset, the perch CLI and MCP clients such as Claude Code and Codex can connect. When false, they cannot, and every request answers "Your organization doesn't allow outside agents."

Type: boolean. Default: `true`.

Example:

```json
false
```

## AllowedMCPClients

Client names as perch clients lists them, for example claude-code or codex. Clients not listed are refused. When unset, every client can connect.

Type: list. Default: unset.

Example:

```json
[
  "claude-code",
  "codex"
]
```

## RemoteControlEnabled

When true or unset, users can let cloud assistants such as Grok Bot drive Perch through the relay. When false, they cannot, and an open relay connection closes.

Type: boolean. Default: `true`.

Example:

```json
false
```

## SyncEnabled

When true or unset, users can turn sync on in Settings > Sync. When false, Perch does not sync and Settings > Sync cannot turn it on. Chrome's SyncDisabled set to true has the same effect.

Type: boolean. Default: `true`.

Example:

```json
false
```

## SyncServerURL

The https address of the sync server, for example a company server that signs people in through the company's identity provider. Data stays end-to-end encrypted.

Type: string. Default: `"https://api.perchbrowser.com"`.

Example:

```json
"https://perch-sync.example.com"
```

## ImportEnabled

browsers lists the browsers users can import from, by key (chrome, safari, arc, firefox and so on). data lists the data types. An empty list allows nothing; a missing key allows everything.

Type: dict. Default: unset.

Example:

```json
{
  "browsers": [
    "chrome",
    "safari"
  ],
  "data": [
    "bookmarks",
    "history",
    "tabs"
  ]
}
```

## BuiltInExtensions

Set backrow or memorySaver to false to turn Backrow watch parties or the memory saver off.

Type: dict. Default: `{"backrow": true, "memorySaver": true}`.

Example:

```json
{
  "backrow": false,
  "memorySaver": true
}
```

## TelemetryEnabled

The ping is off unless a user turns it on. Set this to false to keep it off. True is treated as unset: a policy cannot turn telemetry on.

Type: boolean. Default: `false`.

Example:

```json
false
```

## AuditLogPath

An absolute path, or one starting with ~/, where Perch appends every agent audit entry as a JSON line for the company's security tools. ${USER} is replaced with the user's short name. The copy holds what the local log holds and nothing more.

Type: string. Default: unset.

Example:

```json
"~/Library/Logs/Perch/audit-${USER}.jsonl"
```

## AutoUpdateEnabled

When true or unset, Perch checks for updates and installs them. When false, Perch does not check for updates and hides Check for Updates.

Type: boolean. Default: `true`.

Example:

```json
true
```

## UpdateChannel

stable or beta.

Type: string. Default: `"stable"`.

Example:

```json
"stable"
```

## UpdateDelayDays

Perch offers an update only once it has been public for this many days, from 0 to 30.

Type: integer. Default: `0`.

Example:

```json
7
```

## MinimumVersion

A version in the form x.y.z. When the running Perch is older, it checks for updates at launch and installs the update on quit, unless AutoUpdateEnabled is false.

Type: string. Default: unset.

Example:

```json
"1.4.0"
```
