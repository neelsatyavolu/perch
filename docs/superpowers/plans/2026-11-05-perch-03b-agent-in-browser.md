# Perch plan 3b: the agent in the browser

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** perchd runs inside Perch. The browser starts it, talks to it over a private CDP pipe, and serves the finished TypeScript pages from `ui/` and `ui-pages/`. Side chats belong to their tabs. The agent's tabs sit in a drawn "Agent" group with the perch dot, approvals reach the user wherever they are, and the agent signs in and fills cards and codes without the model seeing a value. Artifacts render on a locked-down `perch-artifact://` origin. Every key Perch holds is wrapped by a Secure Enclave key through a signed helper, and the authenticator in `extension/` gets its key over native messaging. Everything earlier tracks left for "3b" is done or has a named home (see the table at the end).

**Architecture:** This plan builds on plan 2: the `overlay/chrome/browser/perch/` tree, its test targets, the page host from plan 2 task 6, and the build cost rules.
- **Processes.** The browser launches `perchd`, the compiled Bun binary from plan 3a, from inside the app bundle. CDP runs on the child's fds 3/4 through Chromium's own pipe handler, the same transport perchd already speaks. A one-way key channel on fd 5 carries per-profile root keys. No key ever travels over CDP. In development, perchd can still launch the browser with `--remote-debugging-pipe`, and the browser then doesn't start its own perchd.
- **The `Perch` CDP domain** carries everything that needs the browser: tab ids, ownership and groups, task status (the perch dot), revealing a chat, credential and card fill, and the browser data that import and sync need. It is defined in `chrome/browser/devtools/perch_protocol.pdl` and concatenated like `cros_protocol.pdl`. It is only available to trusted clients, which means the pipe.
- **Pages.**
  - `ui/` (side and full-page chat) shows model output and web text, so it runs at `chrome-untrusted://perch-chat/` and `chrome-untrusted://perch-side-chat/`. Each is framed by a small trusted `chrome://` shell that relays the few host calls the chat needs over `postMessage`, in the pattern Chromium's media app uses.
  - `ui-pages/` (new tab page, Settings, Memory, Routines, Import, Welcome) shows the user's own settings, so it runs at `chrome://`, on plan 2's host. The browser answers the methods it owns, and the rest go to perchd's app API.
- **Keys.** A signed Swift helper (`Perch Keys.app`, its own bundle id and provisioning profile) creates a P-256 key in the Secure Enclave and wraps one random 256-bit root key per profile. The browser verifies the helper's code signature, gets the unwrapped root keys, and hands them to perchd on fd 5 and to the authenticator through an in-process native messaging host. perchd derives one key per store with HKDF, and the seven Keychain adapters on today's branches go away.

**Tech Stack:** C++20 and Objective-C++ in Chromium, the DevTools protocol generator, GN, gtest, and headless browser tests. Swift 6 and XCTest for the key helper, built outside the Chromium build. Bun and TypeScript for `perchd/`, `ui/`, `ui-pages/` and `extension/`. Python (`perch-build`).

**Spec:** `docs/superpowers/specs/2026-11-02-perch-design.md`, sections 5.3 (side chats per tab), 5.5 (Ask), 5.8 (agent in incognito), 7.1–7.4, 7.6, 7.7, 11.1, and 15 step 3. Design notes: `docs/design/webui-hosting.md`, which this plan follows except where noted, and `DESIGN.md`. Earlier tracks whose deferrals this plan takes: `2026-11-05-perch-ui-chat.md`, `-ui-pages.md`, `-cli-integrations.md`, `-models.md`, `-mcp-skills.md`, `-memory-routines.md`, `-import.md`, `-sync-server.md`, `-extension.md`, and plan 2's hand-offs.

## Global Constraints

- Plan 2's Global Constraints and build cost table apply unchanged: approval before any build above S, `nice` with 6 jobs, no edits to widely included headers outside the single batched step in task 1, headless tests only, and no GUI driving.
- **The model never sees a secret** (spec 4, 7.2). `Perch.*` fill methods return outcomes, never values. Logins and cards are listed to perchd with ids, usernames, the last four digits and the network, for the approval card only. Those listings never go into a model message, and a test greps the model transcript for them.
- **Keys never cross CDP, a log, a crash key, a URL or a file in plain form.** The fd 5 channel, the in-process native host, and memory are the only places a root key exists outside the Secure Enclave wrap.
- **Untrusted text never runs in a privileged page.** Model output, page text and artifacts render only in `chrome-untrusted://` or `perch-artifact://`. `chrome://` Perch pages render model-written strings (chat titles, memory facts) as text nodes, under Trusted Types.
- **Payments always wait for approval, in every mode** (anti-goal in spec 4). Card fill counts as a payment step.
- One loopback port for perchd's app API, with a per-launch 256-bit token, Origin and Host checks, and allowed origins limited to Perch's page origins (as in `webui-hosting.md`). The token is injected per WebContents and never appears in a URL.
- Commits use `type: description` with no attribution lines.

## Build cost

The same labels as plan 2. Task 1 holds the one **M** step, which edits every shared header this plan needs at once (the DevTools protocol, the side panel entry id and the action id), so later tasks are **S**. The Swift helper, perchd, `ui/`, `ui-pages/` and `extension/` cost nothing on the Chromium side; they are staged into the bundle with `perch-build stage`. Task 16's release build is **L**.

## Review Focus

1. **A CDP client other than perchd reaching `Perch.*`.** The domain is registered only for trusted clients (`IsDomainAvailableToUntrustedClient` stays false). No TCP debugging port is ever opened, and a browser test checks that `--remote-debugging-port` with `Perch.getInfo` returns "method not found". Tasks 1 and 2.
2. **perchd crashes or hangs.** The browser keeps running, the perch dots clear, the pipe handler restarts with a fresh perchd (backoff 1 s, 5 s, 30 s), and the pages show "Perch's agent stopped; restarting" until it is back. It never calls Chromium's `CloseBrowserSoon`. Task 2.
3. **A spoofed key helper or native host.** The browser checks the helper's designated requirement before each launch. The authenticator's host is in-process and answers only the Perch extension's id, so no manifest file on disk can redirect it. Tasks 3 and 4.
4. **A side chat following the wrong tab after a restart.** Tab ids are random GUIDs saved in session restore data, never `SessionID`. A restored tab keeps its chat, and a new tab never inherits one. Task 5.
5. **An artifact leaving its origin.** `location = …`, a meta refresh, `window.open`, a form post and a top-level navigation from `perch-artifact://` are all cancelled. Task 12.
6. **Losing data on a new Mac.** A Secure Enclave key does not survive Migration Assistant. The recovery key and export file from task 3 restore everything, and the welcome page says so (spec 11.1).

---

## File structure

```
perch/
  helpers/keyhelper/                       Swift package: Perch Keys.app (Secure Enclave wrap, CLI protocol)
    Package.swift  Sources/PerchKeys/*.swift  Tests/PerchKeysTests/*.swift  Info.plist  entitlements.plist
  tools/perchtools/stage.py                + perchd binary, key helper, ui/ dist
  tools/perchtools/package.py              + sign perchd (JIT entitlements) and Perch Keys.app before sign_chrome.py
  perchd/src/cdp/adopt.ts                  use inherited fds 3/4 instead of spawning a browser
  perchd/src/secure/key-channel.ts         read fd 5 lines into a KeySource; HKDF per store
  perchd/src/secure/migrate.ts             move every old Keychain item under the new keys, then delete it
  perchd/src/app/pages-api.ts              ui-pages' PerchApi over the app server (JSON RPC + events)
  perchd/src/browser/perch-domain.ts       typed wrappers for Perch.* commands and events
  perchd/src/agent/fill-tools.ts           sign_in, fill_card, fill_code tools
  ui/src/host/frame-host.ts                window.perchHost over postMessage to the trusted shell
  extension/src/totp/native-key.ts         KeyStore backed by chrome.runtime.sendNativeMessage
  overlay/chrome/browser/devtools/perch_protocol.pdl
  overlay/chrome/browser/perch/
    agent/perch_handler.{h,cc}             the Perch domain handler (one per trusted session)
    agent/perchd_launcher.{h,cc}           spawn, fds, restart, shutdown
    agent/tab_identity.{h,cc}              GUID per tab, saved in session extra data
    agent/tab_ownership.{h,cc}             claims, agent groups, capturer counts
    agent/task_status.{h,cc}               perch dot state per tab, profile button dot, notifications
    agent/credential_fill.{h,cc}           ActorLoginService and autofill wrappers
    agent/browser_data.{h,cc}              bookmarks, history, open tabs, import bundle apply
    keys/key_broker.{h,cc}  keys/helper_client_mac.mm  keys/perch_keys_native_host.{h,cc}
    webui/perch_chat_ui.{h,cc}             chrome:// shells and chrome-untrusted:// chat configs
    webui/perchd_bridge.{h,cc}             config.js per WebContents, method routing
    side_panel/perch_side_panel_controller.{h,cc}
    artifacts/perch_artifact_scheme.{h,cc}  artifacts/artifact_url_loader.{h,cc}  artifacts/artifact_navigation_throttle.{h,cc}
    host/file_chooser.{h,cc}  host/dictation_mac.mm
    test/...
  patches/perch/agent/*.patch
```

---

### Task 1: The `Perch` DevTools domain, and the one header step

**Files:**
- Create in the overlay: `chrome/browser/devtools/perch_protocol.pdl`, `chrome/browser/perch/agent/perch_handler.{h,cc}`, `test/perch_domain_browsertest.cc`
- Patch: `agent/devtools-domain.patch`, which touches:
  - `chrome/browser/devtools/BUILD.gn`: in `concatenate_protocols`, add `perch_protocol.pdl` to `inputs` and `args` under `is_mac`, next to the existing `cros_protocol.pdl` lines.
  - `chrome/browser/devtools/inspector_protocol_config.json`: add an `options` entry for `"domain": "Perch"`, with `async` listing the methods that wait on other work (`fillLogin`, `fillCard`, `applyImportBundle`).
  - `chrome/browser/devtools/chrome_devtools_session.cc`: in the constructor's browser-target branch, create `perch_handler_ = std::make_unique<perch::PerchHandler>(dispatcher(), agent_host)` when `channel->GetClient()->IsTrusted()`. The handler is not added to `IsDomainAvailableToUntrustedClient`. `chrome_devtools_session.h` has 2 includers, so adding the member there is cheap.
- Patch: `agent/side-panel-id.patch`, the batched header edit:
  - `chrome/browser/ui/side_panel/side_panel_entry_id.h`: `V(kPerch, kActionSidePanelShowPerch, "Perch")`.
  - `chrome/browser/ui/actions/chrome_action_id.h`: `E(kActionSidePanelShowPerch)`.

  Both are used from task 10 on. They live here so the rebuild they cause happens once.

**Interfaces (the whole domain, filled in by later tasks; each method returns "not implemented" until its task lands):**

```
domain Perch
  experimental
  command getInfo                 returns: version string, chromium string, profiles array of ProfileInfo
  command setAppEndpoint          parameters: origin string, token string          # task 8
  command getTabs                 returns: tabs array of TabInfo                    # task 5
  command claimTab                parameters: targetId, owner TabOwner, render optional boolean
  command releaseTab              parameters: targetId
  command setTabGroup             parameters: targetIds array of string, title string, color optional string   # task 6
  command setTaskStatus           parameters: chatId, status enum [idle, running, waiting], targetIds array, title optional string
  command revealChat              parameters: chatId, tabId optional string, mode enum [side, full]   # task 11
  command listLogins / fillLogin / listCards / fillCard                             # task 7
  command getBookmarks / applyBookmarkChanges / getHistory / getOpenTabs / applyImportBundle   # task 14
  event tabCreated / tabClosed / tabMoved / tabUpdated / tabClaimed / tabReleased   # task 5
  event askRequested             parameters: text, tabId optional string, profile  # task 11
  type TabInfo: tabId (GUID), targetId, windowId, profile, incognito, title, url, pinned, active, owner optional TabOwner
  type TabOwner: chatId, client, label
```

- [ ] **Step 1: Write the failing browser test.** It is `DevToolsProtocolTestBase` (`chrome/browser/devtools/protocol/devtools_protocol_test_support.h`) with `--headless=new` added in `SetUpCommandLine`. `SendCommandSync("Perch.getInfo")` returns the Chromium version, and the test session counts as trusted. A second test attaches an untrusted client through the test support's untrusted mode and gets `-32601`.
- [ ] **Step 2: Implement.** Run `perch-build apply` and build `chrome` and `perch_browser_tests`. **Cost M, once.** It regenerates the protocol sources and rebuilds the side panel and action id includers (about 330 files). Ask the owner first.
- [ ] **Step 3: Run the tests and commit.** `git add -A && git commit -m "feat: Perch DevTools domain for trusted clients, and the side panel id"`

### Task 2: The browser starts perchd

**Files:**
- Create in the overlay: `agent/perchd_launcher.{h,cc}`, `test/perchd_launcher_browsertest.cc`, `test/data/fake_perchd.py` (a fake perchd for tests: reads CDP from fd 3, writes fd 4, logs fd 5 lines)
- Patch: `agent/perchd-launch.patch`, which touches:
  - `content/browser/devtools/devtools_agent_host_impl.cc`: in `StartRemoteDebuggingPipeHandler()`, the POSIX branch also honours `--remote-debugging-io-pipes=<read>,<write>`, parsing two fd numbers (today only `BUILDFLAG(IS_WIN)` reads it through `AdoptPipes`). No header change.
  - `chrome/browser/browser_process_impl.cc`: `CreateDevToolsProtocolHandler()` calls `perch::PerchdLauncher::MaybeLaunch(*base::CommandLine::ForCurrentProcess())` before `RemoteDebuggingServer::GetInstance()`. When it launches, it appends `--remote-debugging-pipe` and `--remote-debugging-io-pipes=<r>,<w>` to the browser's own command line, so Chromium's existing server code starts the pipe handler.
  - `chrome/browser/devtools/remote_debugging_server.cc`: `StartPipeHandler()` binds `on_disconnect` to `perch::PerchdLauncher::OnPipeClosed()` when Perch launched perchd, and to `CloseBrowserSoon` otherwise (dev mode, where perchd launched the browser).
- Create: `perchd/src/cdp/adopt.ts`, `perchd/src/secure/key-channel.ts` (reads lines; keys arrive in task 3) and their tests
- Modify: `perchd/src/cli.ts`, adding a `serve --browser-fds` mode that adopts fds 3/4 and 5 and starts the daemon, app server and MCP endpoints
- Modify: `tools/perchtools/stage.py`, which runs `bun build --compile` for `perchd/src/cli.ts` into `out/<cfg>/perch_web/bin/perchd`, and `chrome/browser/perch/BUILD.gn`, where `bundle_data` puts it in `Perch Framework.framework/Helpers/perchd`
- Modify: `tools/perchtools/package.py`, which signs `perchd` with the hardened runtime and `com.apple.security.cs.allow-jit` (Bun's JIT needs it) before `sign_chrome.py`. The test checks the order.

**Behaviour:**
- `MaybeLaunch` does nothing when any of these hold: `--remote-debugging-pipe` was already given (dev mode), `--perch-no-agent` is set, policy `AgentEnabled` is false (a pref until plan 8), or `--headless` is set without `--perch-agent-in-headless` (tests opt in).
- Otherwise it creates three pipes, launches `Helpers/perchd serve --browser-fds` with `base::LaunchOptions::fds_to_remap` mapping them to child fds 3, 4 and 5, sets `PERCH_DATA_DIR` to the user data dir, and keeps the parent ends.
- On disconnect it calls `StopRemoteDebuggingPipeHandler()`, relaunches with backoff, rewrites the io-pipes switch and calls `StartRemoteDebuggingPipeHandler()` again.
- On browser shutdown it closes fd 5 first (perchd treats EOF as "flush and exit") and kills after 3 s. perchd keeps running only if remote control is on (spec 7.1), which is plan 7's switch.
- perchd's stdout and stderr go to `<user data dir>/Perch Agent/perchd.log`, rotated at 5 MB. perchd already never logs secrets (3a's rule).

- [ ] **Step 1: Write the failing tests.**
  - perchd: `adopt.test.ts` runs a socketpair-backed fake browser and the CDP round trip works over inherited fds. `key-channel.test.ts` parses lines and treats EOF as shutdown.
  - Browser: with `--perch-agent-in-headless --perch-perchd-path=<fake_perchd.py>`, the fake receives `Target.getTargets` results. Killing the fake leads to a relaunch within 2 s and the browser stays up (Review Focus 2). With `--remote-debugging-pipe` given, no perchd is launched.
- [ ] **Step 2: Implement.** Cost **S**: `devtools_agent_host_impl.cc` is in `content`, which relinks its component, and `browser_process_impl.cc` is one file.
- [ ] **Step 3: Real run, headless.** Run `uv run perch-build stage && out/Dev/Perch.app/Contents/MacOS/Perch --headless=new --perch-agent-in-headless about:blank`. `perchd.log` shows "connected to browser" and `perch tabs` (the CLI over perchd's Unix socket) lists the tab.
- [ ] **Step 4: Commit.** `git add -A && git commit -m "feat: Perch starts perchd and speaks CDP to it over a private pipe"`

### Task 3: Secure Enclave keys through a signed helper

**Files:**
- Create: `helpers/keyhelper/` (Swift package, macOS 26+, arm64)
  - `Sources/PerchKeys/Enclave.swift`: create or load the wrap key, a P-256 Secure Enclave key (`kSecAttrTokenIDSecureEnclave`, `SecAccessControlCreateWithFlags(kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .privateKeyUsage)`).
  - `Sources/PerchKeys/Wrap.swift`: wrap and unwrap 32-byte root keys with `SecKeyCreateEncryptedData` and `.eciesEncryptionCofactorVariableIVX963SHA256AESGCM`.
  - `Sources/PerchKeys/Store.swift`: store wrapped blobs as data-protection Keychain items (`kSecUseDataProtectionKeychain`, access group `VTQW687WBQ.co.xanom.perch.keys`, account `root:<profile id>`).
  - `Sources/PerchKeys/Protocol.swift`: 4-byte length-prefixed JSON over stdin/stdout, the same framing as native messaging. Requests are `{op: "get"|"create"|"delete"|"recovery-wrap"|"recovery-unwrap", profile, ...}`.
  - `Tests/`: wrap and unwrap round trip with a software key when no Secure Enclave is present (CI), protocol framing, refusing unknown ops, and refusing a request over 64 KB.
- Create: `helpers/keyhelper/entitlements.plist` (`com.apple.application-identifier`, `keychain-access-groups`) and `Info.plist` (`co.xanom.perch.keyhelper`, `LSUIElement`)
- Create in the overlay: `keys/key_broker.{h,cc}`, `keys/helper_client_mac.mm`, `test/key_broker_unittest.cc`
- Modify: `stage.py` (`swift build -c release --arch arm64`, then assemble `Perch Keys.app` into `Contents/Helpers/`), `package.py` (embed `build/keys.provisionprofile`, sign the helper with its entitlements before `sign_chrome.py`), `tests/test_package.py`
- Modify in perchd, using a `KeySource` from `key-channel.ts`:
  - `src/app/keychain.ts`, `src/config/keychain.ts`, `src/memory/keychain.ts`, `src/daemon/keychain.ts`, `src/sync/keychain.ts`, `src/import/keychain.ts` and `src/secure/keychain.ts` all get their keys from `KeySource.derive("<store>")`, which is HKDF-SHA256 over the profile root key with info `perch/<store>/v1`.
  - Secrets that are values rather than keys move into sealed files under those keys: API keys, OAuth tokens, MCP env secrets, the sync device key, relay keys and the import bundle key. This is `src/secure/sealed.ts`, which already exists.
- Create: `perchd/src/secure/migrate.ts` and its test

**Interfaces:**
- `KeyBroker` (browser, one per process) has `void GetRootKey(const base::FilePath& profile_dir, base::OnceCallback<void(std::optional<crypto::SecureMemory>)>)`. It launches the helper on demand and verifies it first with `SecStaticCodeCreateWithPath` + `SecStaticCodeCheckValidity` against `anchor apple generic and certificate leaf[subject.OU] = "VTQW687WBQ" and identifier "co.xanom.perch.keyhelper"` (Review Focus 3). It caches the keys in memory for the process lifetime, sends `{op: "profile", id, dir, key}` lines on fd 5 at launch and on `ProfileManagerObserver::OnProfileAdded`, and sends `{op: "profile-removed", id}` on removal. Incognito profiles get a random in-memory key that is never stored.
- Recovery (spec 11.1): on first creation the helper also returns `recovery-wrap`, the root key encrypted under the user's recovery key. That is the same recovery key the sync track makes (`perchd/src/sync/recovery.ts`). perchd writes it to `<profile>/Perch Agent/root.recovery`. "Export everything" (an encrypted file) and "Restore from recovery key" are offered on the welcome page and in Settings → Security. If the helper reports a missing Secure Enclave key but a `root.recovery` exists, the browser opens `perch://welcome#restore`.
- Development builds without the provisioning profile: the helper runs ad-hoc signed, falls back to a software key in the login Keychain created through `SecItemAdd` by the helper, and reports `{protected: false}`. Settings → Security then says "Keys are not protected by the Secure Enclave in this build".
- Migration (`migrate.ts`): for each old adapter's item, if present, read it, re-seal its files under the derived key, write a `migrated-v1` marker, then delete the old item. It is idempotent and resumes after a crash midway (the marker is written per store).

**Owner action:** create an App ID `co.xanom.perch.keyhelper` with the Keychain Sharing capability and a Developer ID provisioning profile for it in the Apple developer account. Save it in 1Password, and package.py fetches it to `build/keys.provisionprofile` (gitignored) with `op read`.

- [ ] **Step 1: Write the failing tests.**
  - Swift: `swift test` (no Chromium cost).
  - perchd: `migrate.test.ts` uses fixture MemoryKeychains for all seven adapters, covering migrate, a crash after store 3, migrate again with no double work, and old items deleted.
  - C++: `KeyBrokerTest` with a fake helper binary path (`--perch-keyhelper-path`) and a signature check stub, covering the fd 5 lines on profile add and remove and refusal when the requirement fails.
- [ ] **Step 2: Implement.** Cost **S** on the Chromium side.
- [ ] **Step 3: Release-like check.** Sign the helper with the real profile through `scripts/with-apple-creds.sh uv run perch-build package --mode adhoc` plus a helper-only Developer ID signing (`perch-build sign-helper`). Run `Perch\ Keys.app/Contents/MacOS/PerchKeys` with a `create` request on stdin, and confirm the Keychain item has access group `VTQW687WBQ.co.xanom.perch.keys` (`security dump-keychain -a` on a test macOS user; the models plan's release gate). Never print a key.
- [ ] **Step 4: Commit.** `git add -A && git commit -m "feat: Secure Enclave wrapped profile keys through a signed helper; perchd takes keys from the browser"`

### Task 4: The authenticator's key over native messaging

**Files:**
- Create in the overlay: `keys/perch_keys_native_host.{h,cc}` (an in-process `extensions::NativeMessageHost`), `test/perch_keys_native_host_browsertest.cc`
- Patch: `agent/native-keys-host.patch` on `chrome/browser/extensions/api/messaging/chrome_messaging_delegate.cc`. Before `NativeMessageHost::Create(...)`, when `native_app_name == perch::kKeysHostName` (`"co.xanom.perch.keys"`), use `perch::CreateKeysHost(browser_context, extension_id, error_out)`. It returns `kForbiddenError` unless `extension_id` is the Perch component extension's fixed id (plan 2 task 17) and the profile is not off the record. Chromium's built-in host list (`native_message_built_in_host.cc`) is ChromeOS-only, so Perch doesn't reuse it.
- Create: `extension/src/totp/native-key.ts`, a `KeyStore` (`src/totp/vault.ts`'s interface). `get()` calls `chrome.runtime.sendNativeMessage("co.xanom.perch.keys", {op: "authenticator"})`, imports the 32 bytes with `crypto.subtle.importKey("raw", …, "AES-GCM", false, ["encrypt", "decrypt"])`, overwrites the byte array, and keeps the `CryptoKey` in memory only. `put()` is a no-op because the browser owns the key.
- Modify: `extension/src/totp/stores.ts`, which chooses the native store when `chrome.runtime.sendNativeMessage` answers, and otherwise the IndexedDB store (Chrome for Testing). Remove the release gate in `scripts/build.ts` (`PERCH_PROFILE_KEY`): the authenticator is on whenever the native key answers and off with the existing message otherwise.
- Create: `extension/src/totp/migrate-key.ts`, which re-encrypts records made under an IndexedDB key (dev profiles) and then deletes that key
- Add `"nativeMessaging"` to `extension/static/manifest.json`'s permissions.

**Interfaces:** the host answers one message, `{op: "authenticator"}` → `{key: <base64>}`. That is HKDF over the profile root key with info `perch/authenticator/v1`. Any other message gets an error and the port closes.

- [ ] **Step 1: Write the failing tests.**
  - `extension/test/unit/native-key.test.ts` with a fake `sendNativeMessage`.
  - Browser test: the component extension's service worker calls `sendNativeMessage` and gets 32 bytes. A second, unpacked test extension gets "Access to the specified native messaging host is forbidden". An incognito context is refused.
  - Integration: a TOTP record saved before a browser restart decrypts after it.
- [ ] **Step 2: Implement.** Cost **S**, plus an extension restage.
- [ ] **Step 3: Commit.** `git add -A && git commit -m "feat: authenticator key from the browser over native messaging; authenticator on in Perch builds"`

### Task 5: Stable tab ids and tab ownership

**Files:**
- Create in the overlay: `agent/tab_identity.{h,cc}`, `agent/tab_ownership.{h,cc}`, `test/tab_identity_browsertest.cc`, `test/tab_ownership_browsertest.cc`
- Patch: `agent/tab-identity.patch`, which touches:
  - `chrome/browser/ui/browser_tabrestore.cc`: next to the existing `glic::RestoreGlicStateFromExtraData(web_contents.get(), extra_data)` call, add `perch::RestoreTabIdFromExtraData(web_contents.get(), extra_data)`.
  - `chrome/browser/sessions/session_service.cc`: none needed. `TabIdentity` calls `SessionService::AddTabExtraData(window_id, tab_id, "perch.tab_id", guid)` itself when a tab gets its id, as `chrome/browser/ui/send_tab_to_self/send_tab_to_self_activation_tracker.cc` does.
- Patch: `agent/agent-tabs-never-sleep.patch` is not needed, because plan 2 task 16 left the `SleepController::CannotSleep` hook. `TabOwnership` sets the flag.
- Modify in perchd: `src/browser/perch-domain.ts`, `src/daemon/sessions.ts` (`Perch.setTabGroup` stops being optional when `Perch.getInfo` answers) and the agent loop's "current tab" scope in `src/agent/session.ts`. With a real `tabId`, the loop claims the user's own tab (`Perch.claimTab`) instead of opening its URL in an agent tab. That is the ui-chat deferral.

**Interfaces:**
- `TabIdentity` is a `ui::UnownedUserData` on `tabs::TabInterface::GetUnownedUserDataHost()`. It holds a random `base::Uuid`, created on tab insert, saved with `AddTabExtraData`, restored by the hunk above, and never reused.
- `TabOwnership` is per profile. `Claim(tab, owner, render)` marks the tab and, when `render`, holds `WebContents::IncrementCapturerCount(size, /*stay_hidden=*/true, /*stay_awake=*/true)`, so a background agent tab keeps painting for snapshots, screenshots and the live thumbnail. `Release` drops the hold. Events go to every Perch session.
- `Perch.getTabs` lists every tab in every profile, incognito included and flagged (spec 5.8), with GUIDs. `tabMoved` carries the new window id, so a side chat follows its tab across windows (spec 5.3).

- [ ] **Step 1: Write the failing browser tests.**
  - A tab keeps its GUID across `chrome::RestoreTab` and across a session restore cycle (`SessionServiceTestHelper` + `SessionRestore::RestoreSession` in the test), and a new tab gets a fresh one (Review Focus 4).
  - `claimTab` with `render: true` on a background tab makes `Page.captureScreenshot` on it return a non-blank image.
  - A claimed tab is never discarded by the memory saver.
  - Moving a tab to a new window emits `tabMoved`.
  - perchd test: the "current tab" scope sends `Perch.claimTab` with the right target id, against a fake domain.
- [ ] **Step 2: Implement.** Cost **S**.
- [ ] **Step 3: Commit.** `git add -A && git commit -m "feat: stable tab ids and agent tab ownership in the browser"`

### Task 6: Agent tab groups, the perch dot and approval notices

**Files:**
- Create in the overlay: `agent/task_status.{h,cc}`, `test/task_status_browsertest.cc`
- Patch: `agent/perch-dot.patch`, which touches:
  - `chrome/browser/ui/views/tabs/tab.cc`: when `perch::TaskStatus::ForTab(tab)` is `running`, paint a 6 px accent circle at the favicon's top-right. It breathes through a `gfx::SlideAnimation` (opacity 1 to 0.35, 2.4 s, DESIGN.md), and stops when `gfx::Animation::PrefersReducedMotion()`. `waiting` draws nothing on tabs.
  - `chrome/browser/ui/views/profiles/avatar_toolbar_button.cc`: one still dot while any chat in the profile is `waiting`.
  - `chrome/browser/ui/views/tabs/tab_group_header.cc`: the "Agent" group chip uses plan 2's accent tint style. Agent groups can't be renamed or dragged into while a task runs (`TabGroupEditorBubbleView` is not offered for them).
- Group creation uses `TabStripModel::AddToNewGroup` with `tab_groups::TabGroupVisualData(title, color)`. `setTabGroup` called again with the same title reuses the group. One group per outside session, for example "Claude Code · perch" (the cli-integrations deferral).
- Notices: when a chat becomes `waiting` and Perch is not frontmost, show one macOS notification through `NotificationDisplayService` (`NotificationHandler::Type::TRANSIENT`). The title is the approval card's title, for example "Send message to Alex". Clicking it calls `revealChat` (task 11). Only one notice per waiting chat.

- [ ] **Step 1: Write the failing tests.**
  - `setTabGroup` on two agent tabs makes one group titled "Agent", and a second call adds a third tab to it.
  - `setTaskStatus(running)` makes `TaskStatus::ForTab` running for those tabs only, and `idle` clears it.
  - `waiting` sets the avatar button's dot state (test hook) and queues one notification (`NotificationDisplayServiceTester`).
  - perchd killed means every dot clears (`OnPipeClosed`).
- [ ] **Step 2: Implement.** Cost **S**. Wire perchd's runner (`src/app/runner.ts`) to call `Perch.setTaskStatus` on each status change.
- [ ] **Step 3: Snapshot and commit.** Render running, waiting and the agent group with plan 2's snapshot tool, run the unslop checklist, then `git add -A && git commit -m "feat: agent tab groups, the perch dot and approval notices"`

### Task 7: Credential, card and code fill

**Files:**
- Create in the overlay: `agent/credential_fill.{h,cc}`, `test/credential_fill_browsertest.cc` (fixture login and checkout pages served by the embedded test server)
- Create in perchd: `src/agent/fill-tools.ts` (`sign_in`, `fill_card`, `fill_code`) and `test/fill-tools.test.ts`
- Modify in perchd: `src/agent/tool-specs.ts`, `tools.ts`, `permissions.ts` (credential fill on a site for the first time asks in Guard; `fill_card` is a payment, so it always asks), `src/app/approval-card.ts` ("Sign in to github.com as neel@…", "Fill Visa ending 4242 on store.example"), and `src/page/secrets.ts` (the filled fields join the redaction set; this already exists from 3a)
- Modify: `extension/src/background/index.ts`, which exposes `globalThis.perchFillCode = (tabId, frameUrl) => Promise<"filled"|"no-code"|"no-field">` in the service worker. It fills only when the account's site matches the frame (the extension's existing rule) and never returns the code.

**Interfaces:**
- `Perch.listLogins({targetId}) → {logins: [{loginId, username, origin}]}`. `Perch.fillLogin({targetId, loginId}) → {result: "filled"|"no-form"|"needs-user"|"failed"}`. Both use `password_manager::ActorLoginService` (`components/password_manager/core/browser/actor_login/actor_login_service.h`: `GetCredentials`, `AttemptLogin`) with Chromium's delegate from `chrome/browser/password_manager/actor_login/chrome_actor_login_delegate_client.cc`.
- Spike first, cost S: confirm `ActorLoginServiceImpl` works with plan 2's `features::kGlic` off. If it is gated on glic or actor features, enable only the login-service feature flags in `perch_features.cc` and record which. Passkeys: `needs-user` is returned and the browser's own WebAuthn sheet asks the user, so the model is never involved.
- `Perch.listCards({targetId}) → {cards: [{cardId, network, lastFour, expiry}]}` and `Perch.fillCard({targetId, cardId}) → {result}`. These use the same autofill path as `chrome/browser/actor/tools/autofill/attempt_form_filling/attempt_form_filling_tool.cc`. Read its `Invoke` on the day, call the autofill manager method it calls, and don't depend on the actor framework. CVC entry stays in Chromium's own unmask dialog, typed by the user.
- One-time codes: perchd attaches to the Perch extension's service worker target (`Target.getTargets`, type `service_worker`, the fixed extension id) and calls `perchFillCode` through `Runtime.callFunctionOn`. No browser patch is needed. The value stays in the extension.
- The model sees only `"filled"`, `"no saved login"`, `"no saved card"` or `"needs you"` (spec 7.2).

- [ ] **Step 1: Write the failing tests.**
  - Browser test: a saved login for the test server origin (added through `PasswordStoreInterface::AddLogin` in the test) is listed without a password field, and `fillLogin` fills both fields on `login.html`.
  - The DOM password value equals the saved one (checked in the test, never sent anywhere).
  - The listing JSON contains no password.
  - `fillCard` on `checkout.html` fills number and expiry.
- [ ] **Step 2: Write the failing perchd tests.**
  - `sign_in` in Guard asks the first time per site and not the second.
  - `fill_card` asks even in skip mode.
  - The model-facing tool result is exactly `filled`.
  - A grep of the recorded transcript finds neither the username nor the last four digits.
- [ ] **Step 3: Spike, implement, run and commit.** `git add -A && git commit -m "feat: agent sign-in, card and code fill without the model seeing values"`

### Task 8: Hosting `ui/` and the rest of `ui-pages/`

**Files:**
- Create in the overlay: `webui/perch_chat_ui.{h,cc}`, `webui/perchd_bridge.{h,cc}`, `test/perch_chat_ui_browsertest.cc`
- Modify in the overlay: `webui/perch_pages_ui.cc` (plan 2) adds the hosts below, and `webui/perch_page_handler.cc` forwards non-browser methods
- Patch: `agent/untrusted-webui.patch`, which touches:
  - `chrome/browser/ui/webui/chrome_untrusted_web_ui_configs.cc`: `perch::RegisterPerchUntrustedWebUIConfigs(map)`.
  - `chrome/browser/search/search.cc`: `GetNewTabPageURL()` returns `chrome://perch-newtab/` (the `perch://newtab` alias from plan 2 task 5), and `IsNTPURL()` accepts it.
- Create: `ui/src/host/frame-host.ts` (`window.perchHost` over `parent.postMessage`, with replies matched by id and an origin check) and the shells `ui/static/shell-chat.html` and `shell-side.html` (about 60 lines each: one `<iframe>`, a message relay that accepts only the known host calls, and `chrome.send`)
- Modify: `tools/perchtools/stage.py` stages `ui/dist` to `perch_web/chat/`, and `perch_pages_files.gni` grows a second list

**Hosts:**

| URL | Trust | Serves | Why |
|---|---|---|---|
| `chrome://perch-chat/` (`perch://chat`) | trusted shell | `shell-chat.html` | owns `chrome.send` for host calls |
| `chrome-untrusted://perch-chat/` | untrusted | `chat.html` from `ui/dist` | renders model output and web text |
| `chrome://perch-side-chat/` | trusted shell | `shell-side.html` | side panel host (task 10) |
| `chrome-untrusted://perch-side-chat/` | untrusted | `sidebar.html` | as above |
| `chrome://perch-newtab/`, `perch-memory`, `perch-routines`, `perch-import`, `perch-welcome` | trusted | `ui-pages` entries | the user's own data, rendered as text |

- **Content Security Policy.** It follows `webui-hosting.md` with the origins adjusted:
  - untrusted chat: `script-src 'self'`, `connect-src http://127.0.0.1:<port> ws://127.0.0.1:<port>`, `frame-src perch-artifact:`, `img-src 'self' data: perch-artifact:`, `style-src 'self' 'unsafe-inline'`, `frame-ancestors chrome://perch-chat chrome://perch-side-chat`;
  - shells: `frame-src chrome-untrusted://perch-chat chrome-untrusted://perch-side-chat`;
  - `ui-pages`: plan 2's CSP plus `connect-src` for perchd.
- **Config.** `perchd_bridge` serves `/config.js` per WebContents: `window.perchApp = {api, token, windowId, tabId, theme, accent}` for chat, and `window.perchHost = {available, ...}` plus the perchd origin and token for `ui-pages`. Both come from `Perch.setAppEndpoint`, which perchd calls after its app server starts. perchd's `allowedOrigins` becomes the five untrusted and trusted origins above (`perchd/src/app/server.ts`).
- **Method routing for `ui-pages`.** Browser-owned methods stay in C++ (plan 2's list, plus `chooseFile`, `openFullDiskAccess` and `submitQuery`'s search half). Everything else is sent by `ui-pages/src/api/host.ts` straight to perchd's `POST /api/pages/<method>` with the token, and events come over perchd's WebSocket. Task 9 implements perchd's side.
- **New tab page.** `chrome://perch-newtab` is plan 2's search box plus the chat rail, recent chats, routines and suggestions from perchd. Ask goes through task 11.
- **Fonts.** Geist, Geist Mono and Geist Serif as WOFF2 in both resource sets, with `@font-face` in each page's CSS. No network fonts.

- [ ] **Step 1: Write the failing browser tests.**
  - `perch://chat` loads the shell, which loads the untrusted frame.
  - The frame's `window.perchApp.token` is set, and `location.href` and the history entry contain no token.
  - From the frame, `chrome.send` is undefined.
  - `perchHost.openTab("https://example.test/")` through the shell opens a tab, and `perchHost.openTab("chrome://settings")` is refused by the shell.
  - `perch://newtab` is the NTP for a new tab.
  - Each page's CSP blocks an inline script.
- [ ] **Step 2: Implement.** Cost **S** (new grd lists and two `.cc` hunks). Restage `ui/` and `ui-pages/`.
- [ ] **Step 3: Headless screenshots of every page in Ink and Paper, unslop, then commit.** `git add -A && git commit -m "feat: host the chat in chrome-untrusted frames and every Perch page"`

### Task 9: perchd serves the pages API

TypeScript only. No Chromium build.

**Files:**
- Create: `perchd/src/app/pages-api.ts`, a `PerchApi` (`ui-pages/src/api.ts`) implementation that delegates to the existing modules:
  - models: `createModelRegistry` (`src/models/registry.ts`);
  - MCP and skills: `src/mcp-client/manager.ts`, `registry.ts` and the skill catalog;
  - permissions and audit: `src/agent/permissions.ts`, `audit.ts` and `src/daemon/clients.ts` (`ClientRegistry`);
  - memory: `createMemoryApi` (`src/memory/api.ts`);
  - routines: `createRoutinesApi` (`src/routines/api.ts`);
  - import: `src/import/wizard.ts`;
  - chats: `src/app/chats.ts`;
  - jobs: a small job registry.
- Create: `perchd/src/app/pages-routes.ts`. `POST /api/pages/<method>` takes the JSON array of args; method names are validated against the interface's keys and args against `src/app/validate.ts`. `job:<id>` and `appearance` events go out on the existing WebSocket.
- Create: `perchd/test/pages-api.test.ts`. It runs `ui-pages`' own fake-backed page tests against the real implementation through `src/api/rpc.ts`, using a temp data dir and fake models.
- Modify: `perchd/src/app/main.ts`, which opens everything at startup: `openPerchData(...).start()`, routines' scheduler, the MCP manager, and `chatMemory()` passed into sidebar chats. That is the memory-routines deferral "wiring into the real entry points".

**Rules (`ui-pages/src/api.ts` header):** secret values go in and never come out; pages never name a file path (`chooseFile` ids come from task 13's browser dialog); and everything is per profile, with the profile taken from the page's WebContents through the token's profile binding.

- [ ] **Step 1: Write the failing tests.** Every `PerchApi` method has a happy-path test and one validation failure. `listProviders` never returns a key, `scanMcpImports` returns secret names only, and `startImport` reports progress through `job:<id>`.
- [ ] **Step 2: Implement until `bun test` passes in `perchd/`, `ui-pages/` and `ui/`.**
- [ ] **Step 3: Commit.** `git add -A && git commit -m "feat: perchd implements the pages API: models, skills and MCP, permissions, memory, routines, import"`

### Task 10: The side panel, one chat per tab

**Files:**
- Create in the overlay: `side_panel/perch_side_panel_controller.{h,cc}`, `test/perch_side_panel_browsertest.cc`
- No new patch for registration. Plan 2's `perch::InitWindowFeatures(browser)` hook (in `chrome/browser/ui/browser_window/internal/browser_window_features.cc`) creates the controller. The controller registers one window-scoped `SidePanelEntry` (`SidePanelEntryId::kPerch` from task 1) in the window's global `SidePanelRegistry`, the way `BookmarksSidePanelCoordinator` does (`global_registry.Register(...)` in `chrome/browser/ui/views/side_panel/bookmarks/bookmarks_side_panel_coordinator.cc`). Its view is a `SidePanelWebUIViewT` (`chrome/browser/ui/views/side_panel/side_panel_web_ui_view.h`) on `chrome://perch-side-chat/`, created on first open so a window without the sidebar costs nothing (spec 5.4).
- The toolbar button pins `kActionSidePanelShowPerch` by default through the pinned actions pref in `perch_prefs.cc`, with no patch. Only if the action needs an entry in `chrome/browser/ui/browser_actions.cc` to exist, add one hunk there (`agent/side-panel-action.patch`).
- The shortcut ⌘⇧. (**[builder call]**, next to Safari's ⌘⇧L sidebar) goes in `main_menu_builder.mm` under View → "Show Perch Sidebar".

**Behaviour (spec 5.3, `webui-hosting.md`):**
- `PerchSidePanelController` is per window and is a `TabStripModelObserver`.
- On active tab change it calls perchd `POST /api/windows/<windowId>/active` with `{tab: {id: <GUID>, title, url}}`. The sidebar page saves and restores draft and scroll through perchd, which is already built and tested in `ui/`.
- It keeps one "panel open" bit per tab (`ui::UnownedUserData` next to `TabIdentity`). Switching to a tab whose bit is off closes the panel, and switching back reopens it.
- Navigation and title changes call `PATCH /api/tabs/<id>`. Startup and perchd restart call `PUT /api/tabs` with every tab. Tab close calls `DELETE /api/tabs/<id>`. The move to another window comes from task 5's events.
- Width is remembered per window (`SidePanelCoordinator`'s width pref is per profile, so a per-window value is kept in the controller and applied on open).

- [ ] **Step 1: Write the failing browser tests.** These run against a fake perchd app server (a `net::test_server::EmbeddedTestServer` speaking the routes, so the test doesn't depend on perchd).
  - Open the panel on tab A, switch to B: the panel closes and the fake saw `active` with B.
  - Switch back: the panel reopens with A.
  - Close A: `DELETE`.
  - Restart the session: A's GUID is the same in `PUT /api/tabs`.
- [ ] **Step 2: Implement.** Cost **S**.
- [ ] **Step 3: Snapshot (sidebar open, Ink and Paper), unslop, then commit.** `git add -A && git commit -m "feat: Perch sidebar with a side chat per tab"`

### Task 11: Approvals, Ask, and outside clients in the browser

**Files:**
- Modify in the overlay: `agent/perch_handler.cc` (`revealChat`, `askRequested`), `test/ask_browsertest.cc`
- Patch: `agent/ask.patch` on `chrome/browser/ui/views/omnibox/omnibox_view_views.cc`. In `OmniboxViewViews::HandleKeyEvent`, the `case ui::VKEY_RETURN:` branch calls `perch::AskFromOmnibox(controller()->edit_model(), event)` first when ⌘ is down. It emits `Perch.askRequested({text, tabId})`, closes the popup and doesn't navigate. The `AcceptInput` path is not used, because it turns ⌘ into a new-tab disposition. Chromium 158 also has an "omnibox everywhere" ⌘↵ accelerator (`chrome/browser/ui/omnibox/omnibox_everywhere/`). Check it is off in Perch, and turn its feature off in `perch_features.cc` if not. The NTP's Ask button calls the same path through `submitQuery({mode: "ask"})`.
- Modify in perchd:
  - `src/app/app.ts`: `askRequested` starts a side chat on that tab, or full-page chat when there is no tab.
  - `src/agent/session.ts`: when an approval is pending and the asking client has no elicitation (Codex, `cli-integrations.md`), call `Perch.revealChat({chatId, mode: "side"})` and `setTaskStatus(waiting)`. The card in `ui/` is the answer path.
  - `src/daemon/clients.ts`: a new outside client's first registration becomes a pending approval card ("Allow Codex to use Perch in Guard mode"), not a silent Guard grant. Mode changes from `ui-pages`' Permissions page are already in task 9's API.

**Behaviour:** `revealChat` focuses the window that holds the tab, activates the tab, opens the side panel and scrolls to the card. With `mode: "full"` it opens or focuses `perch://chat?chat=<id>`. The card itself, its exact text and the button that names the action are already built in `ui/` and `perchd/src/app/approval-card.ts`.

- [ ] **Step 1: Write the failing tests.**
  - Browser: typing "summarise this" and pressing ⌘↵ in the omnibox emits `askRequested` with the active tab's GUID, and the tab does not navigate.
  - `revealChat` on a background window's tab activates it and opens the panel.
  - perchd: a Codex-originated risky action without elicitation calls `revealChat` once and waits. A new client registration creates a card.
- [ ] **Step 2: Implement.** Cost **S**.
- [ ] **Step 3: Commit.** `git add -A && git commit -m "feat: Ask from the address bar and new tab page; approvals reach the user in the browser"`

### Task 12: Artifacts on `perch-artifact://`

**Files:**
- Create in the overlay: `artifacts/perch_artifact_scheme.{h,cc}`, `artifacts/artifact_url_loader.{h,cc}`, `artifacts/artifact_navigation_throttle.{h,cc}`, `test/artifact_browsertest.cc`, and test pages that try `location = "https://example.test/?d=…"`, `<meta http-equiv=refresh>`, `window.open`, a form post, and `top.location`
- Patch: `agent/artifact-scheme.patch`, which touches:
  - `chrome/common/chrome_content_client.cc`: `AddAdditionalSchemes()` adds `perch-artifact` to `standard_schemes`, `secure_schemes` and `no_access_schemes`. It is not added to `csp_bypassing_schemes`, because its CSP comes from the loader.
  - `chrome/browser/chrome_content_browser_client.cc`: `CreateNonNetworkNavigationURLLoaderFactory()` and `RegisterNonNetworkSubresourceURLLoaderFactories()` return `perch::CreateArtifactURLLoaderFactory(profile)` for the scheme.
  - `chrome/browser/chrome_content_browser_client_navigation_throttles.cc`: `CreateAndAddChromeThrottlesForNavigation()` adds `perch::ArtifactNavigationThrottle::MaybeCreate(registry)`.
- Modify in perchd: `src/app/artifact-server.ts` gains the option from `webui-hosting.md`, so `urlFor` returns `perch-artifact://<id>/<version>` when the browser runs perchd.

**Behaviour:**
- The loader proxies `perch-artifact://<id>/<version>/<path>` to perchd's artifact server on loopback. The HMAC capability stays in the proxied request, never in the visible URL. The loader copies the artifact server's CSP (`sandbox allow-scripts`, `connect-src 'none'`, the three CDNs) and `X-Content-Type-Options: nosniff`.
- The throttle, on any navigation whose initiator frame or current URL is `perch-artifact://`, cancels when the destination scheme is anything else. That covers renderer-initiated and top-level navigations and form posts. `window.open` from the artifact frame is refused by the sandbox (no `allow-popups`), and a test covers it too.
- "Open as tab" opens the artifact URL in a normal tab with the same CSP. "Save to disk" uses the page's existing `blob:` path (`webui-hosting.md`).

- [ ] **Step 1: Write the failing browser tests.** The artifact renders inside `chrome-untrusted://perch-chat`. Each escape attempt in the test pages ends with the frame still on `perch-artifact://` and no request to `example.test` reaching the embedded server (Review Focus 5). An artifact can't read `document.cookie` or `localStorage`, which throw (an opaque origin). CDN script loads from an allowed CDN, served by the test server through `--host-resolver-rules`.
- [ ] **Step 2: Implement.** Cost **S**.
- [ ] **Step 3: Commit.** `git add -A && git commit -m "feat: perch-artifact:// origin with a navigation lock"`

### Task 13: Host features: files, dictation, @ tabs, live thumbnail, sign-in windows

**Files:**
- Create in the overlay: `host/file_chooser.{h,cc}` (`ui::SelectFileDialog`), `host/dictation_mac.mm` (`SFSpeechRecognizer` with `requiresOnDeviceRecognition = YES`), `test/host_features_browsertest.cc`
- Patch: `agent/speech-usage.patch` on `chrome/tools/build/mac/infoplist_strings_util.cc`, adding `{"NSSpeechRecognitionUsageDescription", permission_reason}` beside the camera and microphone keys (a build tool, so **S**)
- Modify: the `ui/` shells (task 8) relay `chooseFiles`, `startDictation`, `stopDictation` and `listTabs`. Turn on the composer's attach and microphone buttons in `ui/src/components/` (today disabled with a reason). `@` lists tabs from `listTabs`, and memory and skills from perchd.
- Modify in perchd: `POST /api/files` (the browser registers a path the user picked and gets an opaque id; pages never see the path), and `src/app/runner.ts` (live thumbnail)

**Behaviour:**
- **Files:** the browser shows the open panel, then hands perchd the paths, and the page gets ids. This also serves `ui-pages`' `chooseFile` (memory exports, passwords CSV), replacing "perchd's own open panel", which a background Bun binary can't show well. It also gives image editing the attachment model the models track deferred.
- **Dictation:** results stream as partial text into the composer. The first use triggers macOS's speech and microphone prompts. Incognito works but nothing is saved.
- **Live thumbnail (spec 6.1, first moment):** perchd runs `Page.startScreencast` (JPEG, 2 fps, 240 px wide) on the agent tab it is driving. That works in the background because task 5 holds a capturer count. Frames go to the sidebar over perchd's WebSocket.
- **Sign-in windows:** perchd's OAuth flows (`shared-ai-auth` PKCE with a loopback redirect) open the authorize URL in a normal Perch tab through `Target.createTarget`. That is the ui-pages deferral "real sign-in flows".

- [ ] **Step 1: Write the failing tests.**
  - Browser: `chooseFiles` with `ui::SelectFileDialog::SetFactory` set to a test factory returns ids.
  - Dictation is unit tested behind an interface with a fake recogniser. Real speech is an owner check in task 16.
  - perchd: a fake CDP screencast reaches a fake sidebar client.
- [ ] **Step 2: Implement.** Cost **S**.
- [ ] **Step 3: Commit.** `git add -A && git commit -m "feat: file attach, on-device dictation, @ tabs, live agent thumbnail, sign-in in a tab"`

### Task 14: Browser data for import and sync

**Files:**
- Create in the overlay: `agent/browser_data.{h,cc}`, `test/browser_data_browsertest.cc`
- Modify in perchd: `src/import/apply.ts` applies the sealed bundle through these methods (`2026-11-05-perch-import.md`, "applying the bundle"), and `src/sync/` gets adapters for bookmarks, history and open tabs over these methods plus a 15-minute `syncOnce` timer, both only when sync is on (`2026-11-05-perch-sync-server.md`, "local stores and adapters")
- Create: `ui-pages/src/pages/settings/Sync.tsx` (pairing QR drawn from the sync track's payload, devices, recovery key reveal behind Touch ID) and its test

**Interfaces:**
- `Perch.getBookmarks() → tree` and `Perch.applyBookmarkChanges({changes})` use `bookmarks::BookmarkModel`.
- `Perch.getHistory({since}) → visits` uses `history::HistoryService::QueryHistory`.
- `Perch.getOpenTabs()` returns windows, tabs, groups and split pairs.
- `Perch.applyImportBundle({path}) → {applied: {bookmarks, history, passwords, cookies, tabs, searchEngines}, skipped}`. perchd unseals the bundle with its key (task 3) and writes a decrypted temp file with mode 0600, deleted after the call. Chromium-side writes:
  - passwords: `PasswordStoreInterface::AddLogin`;
  - history: `HistoryService::AddPagesWithDetails`;
  - cookies: the profile's `network::mojom::CookieManager::SetCanonicalCookie`;
  - search engines: `TemplateURLService::Add`;
  - tabs: plan 2's `perch::OpenTabsAsleep`, with groups and splits;
  - extensions: queued as Web Store pages for the user to confirm, never installed silently.
- Passwords and extensions don't sync until Chromium's sync protocol lands. That stays deferred, as the sync plan decided.

- [ ] **Step 1: Write the failing tests.**
  - Browser: apply a fixture bundle (made with the import track's `bundle.ts`) and check bookmark count, a history URL, a password in the store, a cookie set, and three tabs open asleep in a group.
  - The temp file is gone after the call.
  - perchd: the import applier and sync adapters pass against a fake domain.
- [ ] **Step 2: Implement.** Cost **S**.
- [ ] **Step 3: Commit.** `git add -A && git commit -m "feat: browser data methods for import and sync; Settings → Sync"`

### Task 15: Agent rules that need the browser and the chat store

TypeScript only. No Chromium build.

**Files:** `perchd/src/app/app.ts`, `src/agent/session.ts`, `src/memory/`, `src/routines/`, and tests

- **Incognito (spec 5.8).** A chat whose tab has `incognito: true` (task 5) runs with memory off, takes its key from the in-memory incognito key (task 3), and is deleted when the last incognito window closes (the browser's `tabClosed` for the last OTR tab). The audit log still records actions, without page text.
- **Heartbeat routines** (wake an existing chat on a schedule) use `src/app/chats.ts`, which now exists.
- **Routine suggestions** ("Find routines to automate"): tasks the user did at least twice in the last 30 days, found from the chat store's first user messages, with a small model call on the fast role to group them. Each one is proposed, never auto-saved (spec 8).
- **The audit log is encrypted per record** under a key derived from task 3 (the cli-integrations and memory-routines deferral).

- [ ] **Step 1: Write the failing tests, implement, and commit.** `git add -A && git commit -m "feat: agent in incognito, heartbeat routines, routine suggestions, encrypted audit log"`

### Task 16: Design review, release build and owner acceptance

- [ ] **Step 1: Design pass.** Snapshot the native chrome (sidebar, perch dots, agent group, profile dot) and take headless screenshots of every page in all five themes. Run the unslop checklist and the template check (spec 6.9), and fix what fails.
- [ ] **Step 2: All tests.** Run `uv run pytest -q`, `perch-build test unit|browser`, `swift test` in `helpers/keyhelper`, `bun test` in `perchd/`, `ui/`, `ui-pages/` and `extension/`, and plan 2's `netaudit` (perchd's own traffic stays on the allowed list: model providers only when a chat runs, and sync and relay only when on).
- [ ] **Step 3: Export and replay the series, and update `docs/rebasing.md`.** Add an "Agent patches" section with one line per patch and the Chromium functions it hooks.
- [ ] **Step 4: Release build. Cost L. Ask the owner first, and say how long it will take.** Then package with the helper's provisioning profile and do a dry-run release.
- [ ] **Step 5: Owner acceptance, by hand:**
  - Sign in to ChatGPT and Grok in a tab, and connect Claude Code.
  - A side chat stays with its tab across switches and a restart.
  - An agent task runs in the "Agent" group with the breathing dot.
  - A Send needs the card, and the notice arrives when Perch is in the background.
  - The agent signs in to a test site from a saved login.
  - A card fill waits for approval.
  - A TOTP code fills on its site.
  - An artifact can't navigate away.
  - Dictation and file attach work.
  - Settings → Security says the keys are protected by the Secure Enclave.
  - Moving the profile to a second macOS user account restores with the recovery key.

---

## Earlier deferrals and where they went

| From | Deferred item | Now |
|---|---|---|
| ui-chat | "Current tab" scope acting in the user's tab | task 5 |
| ui-chat | Blocking self-navigation of artifact frames | task 12 |
| ui-chat | Secure Enclave wrap of the profile key; a Keychain item only Perch can read | task 3 |
| ui-chat | Dictation and file attach; `@` mentions (tabs); live thumbnail | task 13 |
| ui-chat | Dedicated artifact tool; syntax highlighting, math, Mermaid, React artifacts | not 3b: chat UI track, no browser work |
| ui-pages | Wiring into Chromium | plan 2 task 6 (Settings), task 8 (the rest) |
| ui-pages | perchd's implementation of the app API | task 9 |
| ui-pages | Real sign-in flows | task 13 (OAuth in a tab); perchd owns the flows |
| ui-pages | Remote control, Developers, General settings | plans 4, 7 and 8 |
| cli-integrations | Drawing tab groups; tab-ownership domain | tasks 6, 5 |
| cli-integrations | Approvals for clients without elicitation | task 11 |
| cli-integrations | Approving new clients and mode changes in the browser | tasks 11, 9 |
| cli-integrations | Encrypting the audit log per record | task 15 |
| cli-integrations | Compiled `perch` in the bundle | task 2 bundles `perchd`; the `perch` CLI link is plan 4's installer |
| models | Secure Enclave wrap; Keychain items scoped to Perch | task 3 (secrets move into sealed files; no per-secret Keychain items remain) |
| models | Settings → Models page | tasks 8, 9 |
| models | Image editing | task 13 (attachments) |
| models | Device-code sign-in, fast mode on other providers, Copilot and Kimi | not 3b: `shared-ai-auth` and provider work |
| mcp-skills | Secure Enclave wrap | task 3 |
| mcp-skills | Settings → Skills and MCP, per-chat switches, approval cards | tasks 8, 9, 11 |
| mcp-skills | Skill import from URL or git, MCP resources, prompts and sampling, skill scripts | not 3b: perchd features with their own review |
| memory-routines | Secure Enclave wrap, Keychain access | task 3 |
| memory-routines | Heartbeat routines, routine suggestions | task 15 |
| memory-routines | Memory and Routines pages | tasks 8, 9 |
| memory-routines | Wiring into the real entry points | task 9 (`main.ts`) |
| import | Applying the bundle; open tabs asleep | task 14, plan 2 task 16 |
| import | A route from the browser to the wizard API; the wizard UI | tasks 8, 9 |
| sync-server | Local stores and adapters (bookmarks, history, open tabs) | task 14 |
| sync-server | QR rendering, Settings wiring | task 14 (Settings → Sync); `perch login` is plan 4 |
| sync-server | Keychain access control; Secure Enclave wrap of the device key | task 3 |
| sync-server | Chromium sync protocol (passwords, extensions) | still deferred: its own plan after 3b |
| extension | Authenticator release gate (key behind the Keychain / Secure Enclave) | task 4 |
| plan 2 | New tab page, Ask, sidebar button, agent tabs never sleep, sync and relay connection rows | tasks 8, 11, 10, 5, 14 |

## Spec coverage

| Spec item | Task |
|---|---|
| 5.3 side chats belong to a tab; follow it across windows | 5, 10 |
| 5.4 Perch's additions are WebUI, loaded lazily | 8, 10 |
| 5.5 Ask from the address bar (⌘↵) and the new tab page | 8, 11 |
| 5.8 agent in incognito: no memory, chat discarded | 15 |
| 6.1 moment 1, live step line and thumbnail | 13 |
| 6.1 signature, the perch dot | 6 |
| 7.1 perchd started by the browser; CDP over a private pipe; custom CDP domains | 1, 2 |
| 7.2 logins, cards and codes filled by the browser; the model sees only the outcome | 7 |
| 7.2 agent tabs in an "Agent" group | 6 |
| 7.4 approvals show exactly what will be sent; first credential fill asks; payments always ask | 7, 11 |
| 7.6 sidebar, full-page chat, attach, dictation, `@` | 8, 10, 13 |
| 7.7 artifacts on `perch-artifact://`, no network except CDNs, open as tab, save | 12 |
| 11.1 per-profile key wrapped by a Secure Enclave key; recovery key and export | 3 |
| 11.1 every secret in the Keychain or behind the Secure Enclave key | 3 |
| 5.9 authenticator (key) | 4 |
| 10 import applied to the profile | 14 |
| 11.3 browser data adapters (encrypted blob sync) | 14 |

---

## Decisions after the audit (2026-11-08)

- **`Perch.setAppEndpoint`:** not added. The browser picks perchd's port and tokens itself and hands them to perchd on the config pipe at launch (`PerchdLauncher`), so perchd has nothing to report back.
- **Tab events:** `getTabs`, `tabCreated`, `tabClosed`, `tabMoved`, `tabUpdated`, `tabClaimed` and `tabReleased` carry `TabInfo` with the side panel's stable tab GUID (`TabIdFor`). `claimTab` takes `owner` and `render` (default true).
- **Task 3, recovery:** the recovery key is the profile's root key in Crockford base32 (52 characters), shown behind Touch ID. Restore stores the typed key through the helper's new `import` op. `Perch Agent/root.check` (an HMAC of a fixed label under the root key) checks a typed key before anything changes, and when it exists the browser never quietly makes a new key: it opens `perch://welcome#restore`. "Export everything" writes the profile's `Perch Agent` folder as a zip sealed with AES-256-GCM under HKDF(root, "perch/backup/v1"), so the recovery key alone opens it. The `recovery-wrap` and `recovery-unwrap` ops stay for a future sync-held copy.
