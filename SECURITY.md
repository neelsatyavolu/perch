# Security

## Reporting a vulnerability

Email security@<to be set by the owner> with the details. Please do not open a public GitHub issue for a security problem.

Include the Perch version (Perch menu > About Perch), what you did, what happened, and what you expected. A proof of concept helps.

We acknowledge every report within 2 days and tell you what we plan to do about it.

## What is in scope

- Perch's patches to Chromium (`patches/` and `overlay/`)
- `perchd`, the local daemon behind the agent, memory, the MCP server and remote control
- The Perch sync and relay server (`server/`), including a company's self-hosted copy
- The Perch extension (`extension/`) and the built-in extensions Perch ships

## What goes to Chromium

A bug in Chromium itself, one that also affects Chrome or Chromium built without Perch's patches, belongs with the Chromium project. Report it as Chromium's [security bug guide](https://www.chromium.org/Home/chromium-security/reporting-security-bugs/) describes. If you are not sure which side a bug is on, send it to us and we will pass it on.

## Chromium security fixes

When Google releases a Chrome stable update with security fixes, Perch moves to that Chromium version and releases within 72 hours. Each release lists its Chromium version and the patches applied, and attaches an SBOM (`Perch-<version>.spdx.json`) and `SHA256SUMS`. Release builds are signed and notarized, and Sparkle updates are EdDSA-signed.

## Supported versions

Only the latest release gets security fixes. Perch updates itself unless a company turns updates off by policy (see [docs/enterprise/deploying.md](docs/enterprise/deploying.md)).
