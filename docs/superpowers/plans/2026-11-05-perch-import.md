# Perch import (spec section 10)

**Branch:** `perch/import`. **Code:** `perchd/src/import/`. **Tests:** `perchd/test/import/`.

## Goal

Bring a user's data from the browsers already on their Mac into Perch: detect each browser and profile, show what each one holds, import the chosen types with progress, and say exactly what failed and why. Readers are plain TypeScript in `perchd`, tested against generated fixture profiles in a temp HOME. No real user data is read by tests.

## Aside parity checklist

Aside (docs.aside.com, changelog to 2026-11-01) imports history, cookies, bookmarks and passwords from Chrome, Arc, Safari, Firefox, Chromium, Dia, Atlas, Comet and Helium; picks a profile when there are several; explains missing macOS permissions; imports Safari from the ZIP that Safari's File > Export makes; has a bookmarks-only import; refuses to import the same full profile twice.

| Aside | Perch |
|---|---|
| Chrome, Arc, Chromium, Dia, Comet, Helium, Atlas | yes, plus Brave, Edge, Vivaldi, Opera, Aside itself |
| Firefox | yes, plus Zen |
| Safari ZIP export | yes, and direct read of Safari's files (bookmarks, history, cookies) when Full Disk Access is granted |
| History, bookmarks, passwords, cookies | yes; cookies only when the user opts in |
| Profile picker | yes, every profile from `Local State` / `profiles.ini` |
| Explains missing permissions | yes, per data type, before asking |
| Bookmarks-only import, HTML file | yes (Netscape bookmarks HTML) |
| Same profile not imported twice | bookmarks and history already in Perch are skipped; for everything else there is one pending bundle per source, and a second run replaces the parts it re-imports instead of adding another copy |
| (not in Aside) | open tabs and windows, search engines, addresses, extension list, Aside memory, skills and chats, per-type counts before import, a failure report per type |

## Where imported data goes (the choice)

Two paths, chosen per data type:

1. **Written straight into the Perch profile in Chromium's own formats, only while Perch is closed** (`SingletonLock` absent or its process gone): `Bookmarks` (JSON with Chromium's MD5 checksum, merged under an "Imported from X" folder) and `History` (rows added to the `urls` and `visits` tables Chromium created). These are the bulk types and need no browser change.
2. **An import bundle for a later version of Perch to apply**, for everything else: open tabs and windows (restored asleep needs the shell's lazy-restore patch, plan 2), search engines, addresses, extensions to reinstall, passwords, cookies, Aside memory, skills and chats. The bundle is sealed with AES-256-GCM; its key lives in the Keychain (`Perch Import` item), never next to the file. The browser (plan 2/3b) opens it, hands each part to Chromium's own services (`ProfileWriter`, the same path Chrome's importer uses), then deletes the file and the key. While Perch is open, bookmarks and history go into the bundle too. The browser side does not exist yet, so the wizard and the terminal say the data is saved for a later version, not that it is in Perch. Importing the same source again merges into its pending bundle (newer parts replace older ones) and removes the old file and key.

Cookies go straight into a running Perch over the DevTools pipe (`Storage.setCookies`) when the caller passes perchd's connection (`running`), so a cookie import works without a restart. Partitioned (CHIPS) cookies are left out, as Firefox's partitioned ones are, so a third party's per-site cookie never becomes readable across sites.

**Keychain.** perchd calls Security.framework in-process (`mac-security.ts`, bun:ffi), never `/usr/bin/security`. The Safe Storage prompt names Perch, and the wizard says to choose Allow (Always Allow is not needed). The bundle key item is created with an access list naming perchd and the apps the caller passes (Perch.app), so no shared system tool can read it without a prompt.

## File layout

| File | Job |
|---|---|
| `types.ts` | Normalised, read-only data types and the data-type list |
| `time.ts` | Chromium, WebKit, Mac and Unix timestamp conversions |
| `sqlite-copy.ts` | Copy a SQLite file (and its WAL) to a private temp dir, open it, clean up |
| `keychain.ts` | Keychain interface, macOS implementation, in-memory fake for tests |
| `mac-security.ts` | Security.framework calls through bun:ffi: find, create with an access list, delete |
| `catalog.ts` | Every supported browser: folder, Keychain item, family |
| `detect.ts` | Find installed browsers and profiles; Full Disk Access check |
| `chrome/crypto.ts` | Safe Storage key derivation, v10 AES-128-CBC decrypt and encrypt |
| `chrome/*.ts` | Bookmarks, history, logins, Web Data (search engines, addresses), cookies, extensions, sessions (SNSS) |
| `safari/*.ts` | Binary plist, Bookmarks.plist, History.db, Cookies.binarycookies, the File > Export ZIP |
| `firefox/*.ts` | profiles.ini, places.sqlite, cookies.sqlite, mozLz4 session store |
| `files/*.ts` | Password CSV and Netscape bookmarks HTML |
| `aside.ts` | Aside memory, skills and chats |
| `write/*.ts` | Profile lock check, Bookmarks writer with checksum, History writer |
| `bundle.ts` | Seal and open the import bundle |
| `cookies-cdp.ts` | Apply cookies to a running browser |
| `wizard.ts` | detect, count, import with progress, report |

## Tasks

1. Core: types, time, sqlite copy, keychain, catalog, detect.
2. Chrome family readers, each with a generated fixture, including a real v10-encrypted login and cookie made with a fake key.
3. Safari readers (plist parser, FDA detection, ZIP export).
4. Firefox readers (places, cookies, session store).
5. Password CSV, bookmarks HTML, Aside extras.
6. Writers for Bookmarks and History, checked against a profile made by a real Chrome for Testing run.
7. Sealed bundle and cookie apply over CDP.
8. Wizard API.

## Deferred

- **Firefox passwords** (NSS `key4.db` + `logins.json`): needs ASN.1, PBES2 and 3DES handling and a primary-password prompt. The wizard explains it and offers the CSV route (Firefox: about:logins > Export), which the CSV reader handles.
- **Safari open tabs** (`SafariTabs.db`, undocumented schema that changes between releases).
- **Arc spaces as tab groups** (`StorableSidebar.json`): Arc's normal Chromium session file is read; space structure is left for later.
- **Applying the bundle**: the browser side (plan 2/3b patches) is not in this track. Until it lands, bookmarks and history (Perch closed) and cookies (Perch running) are the types that reach Perch.
- **A route from the browser to the wizard API**: perchd has no socket or WebUI channel yet; the terminal command is the only entry point. Not exposed over MCP, since agents should not start password imports.
- **The wizard UI**: this track provides the API; the screen belongs to the WebUI track and follows DESIGN.md.
