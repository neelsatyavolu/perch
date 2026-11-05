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
| Safari ZIP export | yes, and direct read of Safari's files when Full Disk Access is granted |
| History, bookmarks, passwords, cookies | yes; cookies only when the user opts in |
| Profile picker | yes, every profile from `Local State` / `profiles.ini` |
| Explains missing permissions | yes, per data type, before asking |
| Bookmarks-only import, HTML file | yes (Netscape bookmarks HTML) |
| Same profile not imported twice | duplicate bookmarks, history rows and passwords are skipped, so a second run adds nothing |
| (not in Aside) | open tabs and windows, search engines, addresses, extension list, Aside memory, skills and chats, per-type counts before import, a failure report per type |

## Where imported data goes (the choice)

Two paths, chosen per data type:

1. **Written straight into the Perch profile in Chromium's own formats, only while Perch is closed** (`SingletonLock` absent or its process gone): `Bookmarks` (JSON with Chromium's MD5 checksum, merged under an "Imported from X" folder) and `History` (rows added to the `urls` and `visits` tables Chromium created). These are the bulk types and need no browser change.
2. **An import bundle the browser applies at its next start**, for everything else: open tabs and windows (restored asleep needs the shell's lazy-restore patch, plan 2), search engines, addresses, extensions to reinstall, passwords, cookies, Aside memory, skills and chats. The bundle is sealed with AES-256-GCM; its key lives in the Keychain (`Perch Import` item), never next to the file. The browser (plan 2/3b) opens it, hands each part to Chromium's own services (`ProfileWriter`, the same path Chrome's importer uses), then deletes the file and the key. While Perch is open, bookmarks and history go into the bundle too.

Cookies can also be applied to a running Perch over the DevTools pipe (`Storage.setCookies`), which perchd already holds, so a cookie import works without a restart.

## File layout

| File | Job |
|---|---|
| `types.ts` | Normalised, read-only data types and the data-type list |
| `time.ts` | Chromium, WebKit, Mac and Unix timestamp conversions |
| `sqlite-copy.ts` | Copy a SQLite file (and its WAL) to a private temp dir, open it, clean up |
| `keychain.ts` | Keychain interface, macOS `security` implementation, in-memory fake for tests |
| `catalog.ts` | Every supported browser: folder, Keychain item, family |
| `detect.ts` | Find installed browsers and profiles; Full Disk Access check |
| `chrome/crypto.ts` | Safe Storage key derivation, v10 AES-128-CBC decrypt and encrypt |
| `chrome/*.ts` | Bookmarks, history, logins, Web Data (search engines, addresses), cookies, extensions, sessions (SNSS) |
| `safari/*.ts` | Binary plist, Bookmarks.plist, History.db, the File > Export ZIP |
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
- **Applying the bundle**: the browser side (plan 2/3b patches) is not in this track. Until it lands, bookmarks and history are the types that reach Perch without it.
- **The wizard UI**: this track provides the API; the screen belongs to the WebUI track and follows DESIGN.md.
