# Perch plan 1: fork pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command checks out a pinned Chromium Stable, applies Perch's patch series, and builds `Perch.app`. Another command signs it, notarizes it and publishes a DMG with a Sparkle update feed. The first release is installed on the owner's Mac and updates itself.

**Architecture:** A small Python tool, `perch-build`, lives in the Perch repo and drives everything. Chromium lives outside the repo in `~/chromium-perch`. Perch's changes live in three places:
- `patches/`: unified diffs listed in `patches/series`.
- `overlay/`: whole files copied into the tree.
- Generated steps, such as the product-name substitution.

`apply` turns each of these into one git commit on a local `perch` branch on top of the Chromium tag. Rebasing means replaying those commits onto a new tag, and `export` writes the commits back out as patch files. Signing uses Chromium's own `sign_chrome.py`. Notarization and Sparkle follow agterm's release flow.

**Tech Stack:** Python 3.12+ with uv, pytest and pytest-cov (stdlib only at runtime). depot_tools, gn and autoninja. Xcode 27. Sparkle 2. `xcrun notarytool`, `gh`, and 1Password `op`. Objective-C++ for the in-browser updater.

**Spec:** `docs/superpowers/specs/2026-11-02-perch-design.md` (sections 5.1, 5.2, 6, 12.4, 15 step 1, 16). Roadmap: `docs/superpowers/plans/2026-11-03-perch-roadmap.md`.

## Global Constraints

- macOS on Apple silicon only: `target_cpu="arm64"`. No Intel and no universal builds.
- Product name `Perch`, bundle id `co.xanom.perch`, data in `~/Library/Application Support/Perch`, and a Keychain item named `Perch Safe Storage`.
- Chromium is pinned to the current Stable tag. Perch's changes are a patch series plus added source directories, applied by script to a clean checkout.
- Widevine: `enable_widevine=true`, and the CDM comes from Chromium's component updater. No DRM workarounds of any kind.
- Signing: Developer ID from 1Password through `~/Documents/GitHub/agmux/scripts/load-apple-creds.sh`, then notarized. Sparkle updates come from GitHub Releases `appcast.xml`, and the EdDSA key lives in 1Password. One update check per day.
- Licences: Chromium is BSD and Perch is MIT (`Copyright (c) 2026 Neel Satyavolu`). Borrowed patches keep their licence and credit in a header comment.
- Never print, log or commit a secret value. Secrets go to 0600 temp files that are deleted on exit.
- Never capture the screen or drive the GUI. Agents verify with tests, headless runs, `codesign`, `spctl` and `strings`. GUI checks are owner steps.
- The Chromium checkout and build output stay outside the repo (about 100 GB).
- Commits use the `type: description` format with no attribution lines. Commit or push only as the plan says.
- All copy follows spec 6.6 and `~/ANTI AI WRITING.md`. Mac menu items use title case, as Chromium's do.

## Review Focus

1. **A patch stops applying after a rebase.** `apply` must stop at that patch, name it, leave `.rej` files, and save its place, and `apply --continue` must resume. It must never leave a half-applied tree without saying so. Test in task 3.
2. **Running `apply` twice, or on a tree with stray edits.** It resets to the tag first, so the result is identical, and `out/` is untouched. Test in task 3.
3. **Perch installed next to Chrome or Chromium.** It must use its own data folder and Keychain item, and never read or write Chromium's. Verified in task 5.
4. **A dev build with no Sparkle.framework, or no network.** It launches normally, with no crash and no "Check for Updates…" item. Verified in task 6.
5. **Secrets reaching logs.** `run()` masks secret values in the command lines it logs, and key files are deleted even when a step fails. Tests in tasks 1 and 7.

---

## File structure

```
perch/
  LICENSE  README.md  .gitignore  pyproject.toml  version.json
  .github/workflows/tools.yml
  build/args/common.gn  build/args/dev.gn  build/args/release.gn
  build/sparkle.json                         pinned Sparkle version, URL, sha256
  branding/perch-mark.svg  branding/render-icons.swift
  overlay/                                   files copied over src/ (icons, new sources)
    chrome/browser/perch/perch_updater_mac.h
    chrome/browser/perch/perch_updater_mac.mm
  patches/series
  patches/perch/branding/*.patch  patches/perch/updater/*.patch
  scripts/with-apple-creds.sh  scripts/maintainer.local.example
  tools/perchtools/
    __init__.py  cli.py       argparse entry: perch-build <command>
    paths.py                  where Chromium, depot_tools and out dirs live
    run.py                    subprocess wrapper with secret redaction
    version.py                version.json, chromiumdash lookup, version bumps
    doctor.py                 machine checks
    checkout.py               .gclient, clone tag, gclient sync, runhooks
    series.py  patching.py    series file, apply/continue/export
    rename.py                 product-name substitution in *chromium_strings*.grd*
    gnargs.py                 args.gn composition, gn gen, autoninja
    plist.py  sparkle.py  package.py  release.py
  tests/                      one test file per module, plus tests/fixtures/
  docs/building.md  docs/rebasing.md  docs/drm-status.md
```

---

### Task 1: Tool skeleton, paths, safe `run()`, versions

**Files:**
- Create: `LICENSE`, `README.md`, `.gitignore`, `pyproject.toml`, `version.json`, `.github/workflows/tools.yml`
- Create: `tools/perchtools/{__init__,cli,paths,run,version}.py`
- Test: `tests/test_run.py`, `tests/test_version.py`, `tests/test_paths.py`

**Interfaces:**
- Produces:
  - `Paths(repo: Path, chromium: Path, src: Path, depot_tools: Path)` with `out(config: str) -> Path` (returns `src / "out" / config.capitalize()`), and `load_paths(env: Mapping[str, str]) -> Paths`. Defaults are `~/chromium-perch` and `~/depot_tools`, overridden by `PERCH_CHROMIUM_DIR` and `PERCH_DEPOT_TOOLS`.
  - `run(cmd: Sequence[str], *, cwd: Path | None = None, env: Mapping[str, str] | None = None, secrets: Sequence[str] = (), check: bool = True, capture: bool = False) -> subprocess.CompletedProcess[str]`. It logs `$ <cmd>` to stderr with every secret replaced by `***`.
  - `redact(text: str, secrets: Sequence[str]) -> str`.
  - `VersionInfo(perch: str, build: int, chromium: str)` (frozen dataclass). Also `read_version(path: Path) -> VersionInfo`, `write_version(path: Path, info: VersionInfo) -> None`, `latest_stable_mac(fetch_json: Callable[[str], Any]) -> str`, `bump(info: VersionInfo, kind: Literal["rebase", "security", "perch"], chromium: str | None = None) -> VersionInfo`, and `bundle_versions(info: VersionInfo) -> dict[str, str]`.
  - `cli.main(argv: list[str]) -> int`. Subcommands are registered by later tasks, and this task registers `version`.

The version rules are decided here:
- `CFBundleShortVersionString` is `perch` (for example `0.1.0`).
- `CFBundleVersion` is `str(build)`, an integer that goes up by one on every release. That number is the only thing Sparkle compares.
- The tag is `v<perch>`.
- `bump` with `"rebase"` sets a new `chromium`, bumps the minor version and resets the patch number: 0.1.3 becomes 0.2.0.
- `"security"` sets a new `chromium` and bumps the patch number.
- `"perch"` bumps the patch number and keeps `chromium`.
- Every kind adds 1 to `build`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_run.py
def test_redact_masks_every_secret():
    assert redact("op read x --key abc123 --pw s3cr3t", ["abc123", "s3cr3t"]) == "op read x --key *** --pw ***"
def test_redact_ignores_empty_secret():
    assert redact("plain", [""]) == "plain"
def test_run_logs_redacted_command(capsys):
    run(["echo", "token-xyz"], secrets=["token-xyz"], capture=True)
    assert "token-xyz" not in capsys.readouterr().err

# tests/test_version.py
STABLE = [{"channel": "Stable", "platform": "Mac", "version": "142.0.7444.59"}]
def test_latest_stable_mac_reads_chromiumdash():
    seen = []
    v = latest_stable_mac(lambda url: seen.append(url) or STABLE)
    assert v == "142.0.7444.59"
    assert seen == ["https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=1"]
def test_bump_rebase():
    assert bump(VersionInfo("0.1.3", 7, "142.0.7444.59"), "rebase", "143.0.7500.20") == VersionInfo("0.2.0", 8, "143.0.7500.20")
def test_bump_security():
    assert bump(VersionInfo("0.2.0", 8, "143.0.7500.20"), "security", "143.0.7500.31") == VersionInfo("0.2.1", 9, "143.0.7500.31")
def test_bump_perch_keeps_chromium():
    assert bump(VersionInfo("0.2.1", 9, "143.0.7500.31"), "perch") == VersionInfo("0.2.2", 10, "143.0.7500.31")
def test_bump_rebase_requires_chromium():
    with pytest.raises(ValueError): bump(VersionInfo("0.1.0", 1, "142.0.7444.59"), "rebase")
def test_bundle_versions():
    assert bundle_versions(VersionInfo("0.1.0", 1, "142.0.7444.59")) == {"CFBundleShortVersionString": "0.1.0", "CFBundleVersion": "1"}
def test_version_roundtrip(tmp_path): ...  # write_version then read_version returns an equal VersionInfo

# tests/test_paths.py
def test_defaults(monkeypatch): ...   # with only HOME set: chromium == ~/chromium-perch, src == chromium/"src", out("release") == src/"out/Release"
def test_env_overrides(): ...         # PERCH_CHROMIUM_DIR and PERCH_DEPOT_TOOLS win
```

- [ ] **Step 2: Run them and confirm they fail.** `uv run pytest -q` should fail with import errors.
- [ ] **Step 3: Implement the modules.** Use `urllib.request` for `fetch_json` in the CLI only; tests inject a fake. `perch-build version` prints the current version, `--set-latest` writes `latest_stable_mac()` into `chromium`, and `--bump perch|security|rebase [<chromium>]` writes `bump(...)`. Set up the following:
  - `pyproject.toml`: project `perchtools`, `requires-python = ">=3.12"`, script `perch-build = "perchtools.cli:main"`, dev group `pytest`, `pytest-cov`, and package dir `tools`.
  - `version.json`: start at `{"perch": "0.1.0", "build": 1, "chromium": "<latest_stable_mac() today>"}`, filled by running `uv run perch-build version --set-latest`.
  - `.gitignore`: `scripts/maintainer.local`, `dist/`, `.venv/` and `__pycache__/`.
  - `LICENSE`: MIT, `Copyright (c) 2026 Neel Satyavolu`.
  - `README.md`: what Perch is (spec section 1, two sentences) and a link to `docs/building.md`.
  - CI: `ubuntu-latest`, `astral-sh/setup-uv`, `uv run pytest --cov=perchtools --cov-fail-under=80`.
- [ ] **Step 4: Run the tests.** `uv run pytest -q` should pass. `uv run perch-build version` should print `Perch 0.1.0 (build 1) on Chromium <version>`.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: add perch-build skeleton, versions and redacting runner"`

### Task 2: Doctor and Chromium checkout

**Files:**
- Create: `tools/perchtools/doctor.py`, `tools/perchtools/checkout.py`
- Modify: `tools/perchtools/cli.py` (add `doctor` and `checkout`)
- Test: `tests/test_doctor.py`, `tests/test_checkout.py`

**Interfaces:**
- Consumes: `Paths`, `run`, `read_version`.
- Produces:
  - `Check(name: str, ok: bool, detail: str)`.
  - `run_checks(probe: Probe, paths: Paths) -> list[Check]`. `Probe` is a Protocol with `machine() -> str`, `xcode_path() -> str`, `free_bytes(path: Path) -> int`, `exists(path: Path) -> bool` and `python_version() -> tuple[int, int]`.
  - `gclient_text() -> str`.
  - `checkout(paths: Paths, version: str, run=run) -> None`.

The checks:
- `machine() == "arm64"`.
- The Xcode path starts with `/Applications/Xcode`, so the Command Line Tools alone are not enough.
- At least 120 GiB is free on the volume that will hold `paths.chromium` (or its nearest existing parent).
- Python is 3.12 or newer.
- depot_tools is present. When it is missing, the check fails with the detail `run: git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git <path>`.

`gclient_text()` returns exactly this:

```python
solutions = [{"name": "src", "url": "https://chromium.googlesource.com/chromium/src.git",
  "managed": False, "custom_deps": {}, "custom_vars": {"checkout_pgo_profiles": True}}]
target_os = ["mac"]
```

The PGO profiles matter: official builds use them, and without them Perch would miss the speed target in spec section 13.

`checkout` runs these steps in order, with depot_tools prepended to `PATH`:
1. Write `<chromium>/.gclient`.
2. If `src` is missing, run `git clone --depth 1 --branch <version> https://chromium.googlesource.com/chromium/src.git src`. Otherwise run `git -C src fetch --depth 1 origin tag <version> --no-tags` and then `git -C src checkout -f tags/<version>`.
3. `gclient sync --no-history --nohooks -D` in `<chromium>`.
4. `gclient runhooks` in `<chromium>`.
5. `tmutil addexclusion <chromium>`, so Time Machine skips the 100 GB.

- [ ] **Step 1: Write the failing tests**

```python
def test_checks_pass_on_good_machine(fake_probe_ok, paths): assert all(c.ok for c in run_checks(fake_probe_ok, paths))
def test_intel_fails(fake_probe_ok, paths): ...            # machine "x86_64" gives a failed check named "arm64"
def test_clt_only_fails(fake_probe_ok, paths): ...         # xcode_path "/Library/Developer/CommandLineTools" fails
def test_low_disk_fails(fake_probe_ok, paths): ...         # 100 GiB free fails, and the detail names "120 GiB"
def test_missing_depot_tools_says_how(fake_probe_ok, paths): ...  # detail contains "git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git"
def test_gclient_text_pins_pgo(): assert '"checkout_pgo_profiles": True' in gclient_text() and 'target_os = ["mac"]' in gclient_text()
def test_checkout_fresh_runs_clone_then_sync(tmp_path, recorder): ...
    # recorded commands, in order: git clone --depth 1 --branch 142.0.7444.59 ..., gclient sync --no-history --nohooks -D, gclient runhooks, tmutil addexclusion
def test_checkout_existing_fetches_tag(tmp_path, recorder): ...  # src exists, so fetch tag then checkout -f tags/<v>; no clone
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement `doctor.py`, `checkout.py` and the CLI commands.** `perch-build doctor` prints one line per check and returns 1 if any fail. `perch-build checkout` runs doctor first and refuses to continue on a failure.
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Real checkout. This takes about an hour.** Run `uv run perch-build doctor && uv run perch-build checkout`. Success means `git -C ~/chromium-perch/src describe --tags` prints the version in `version.json`.
- [ ] **Step 6: Commit.** `git commit -am "feat: add doctor and pinned Chromium checkout"`

### Task 3: Patch series engine

**Files:**
- Create: `tools/perchtools/series.py`, `tools/perchtools/patching.py`, `patches/series` (comment header only for now), `overlay/.keep`
- Modify: `tools/perchtools/cli.py` (add `apply [--continue]` and `export`)
- Test: `tests/test_series.py`, `tests/test_patching.py`, plus a `tests/conftest.py` fixture `chromium_like(tmp_path)` that builds a small git repo with files `a.txt` and `b/c.txt`, commits them, and tags `1.0.0.0`

**Interfaces:**
- Consumes: `Paths`, `run`.
- Produces:
  - `read_series(path: Path) -> list[str]`. Skips blank lines and `#` comments, and raises `SeriesError` on duplicates or on a listed file that does not exist.
  - `Generator = tuple[str, Callable[[Path], None]]`, a name and a function that edits `src` in place.
  - `apply_series(src: Path, tag: str, patches_dir: Path, overlay_dir: Path, generators: Sequence[Generator], state_file: Path) -> None`.
  - `continue_series(src: Path, patches_dir: Path, generators: Sequence[Generator], state_file: Path) -> None`.
  - `export_series(src: Path, tag: str, patches_dir: Path) -> list[Path]`.
  - `PatchFailed(Exception)`, with `.patch: str` and `.rejects: list[Path]`.

The commit model, which the next tasks and `docs/rebasing.md` rely on:

1. Reset: `git -C src checkout -f -B perch <tag>` and then `git -C src clean -fd`. There is no `-x`, so ignored paths like `out/` and DEPS checkouts survive.
2. Copy `overlay/` over `src/` and commit it as `perch-generated: overlay`.
3. For each patch in `series`: `git apply --index <patch>`, then commit with the patch's path relative to `patches/` as the message (for example `perch/branding/branding-file.patch`). If the apply fails, run `git apply --reject <patch>`, write `{"tag", "failed": name, "remaining": [...]}` to the state file and raise `PatchFailed`.
4. Run each generator and commit it as `perch-generated: <name>`, skipping the commit when nothing changed.

`continue_series` stages everything, commits it under the failed patch's name, and carries on from `remaining`. The commit fails if any `*.rej` file is still in the tree. `export_series` walks `tag..perch`, skips the `perch-generated:` commits, and writes `git diff --no-color --no-ext-diff <c>^ <c>` to `patches/<message>`. The state file lives at `<chromium>/perch-apply-state.json`, outside `src`, so `clean` never removes it.

- [ ] **Step 1: Write the failing tests**

```python
def test_read_series_skips_comments(tmp_path): ...       # "# x\n\nperch/a.patch\n" gives ["perch/a.patch"]
def test_read_series_rejects_duplicates(tmp_path): ...   # raises SeriesError
def test_read_series_rejects_missing_file(tmp_path): ... # raises SeriesError naming the file
def test_apply_commits_overlay_patches_generators(chromium_like, patch_dirs):
    apply_series(src, "1.0.0.0", patches, overlay, [("upper", upper_a)], state)
    assert log_messages(src) == ["perch-generated: upper", "perch/two.patch", "perch/one.patch", "perch-generated: overlay"]
def test_apply_twice_is_identical(chromium_like, patch_dirs):          # Review Focus 2
    apply once and record HEAD's tree hash; write a stray edit to a.txt and an untracked junk.txt; apply again
    assert tree hash equal; junk.txt gone; src/"out"/"keep.bin" (ignored via .gitignore) still exists
def test_failing_patch_stops_and_names_it(chromium_like, patch_dirs):  # Review Focus 1
    with pytest.raises(PatchFailed) as e: apply_series(...)   # two.patch conflicts
    assert e.value.patch == "perch/two.patch" and any(p.suffix == ".rej" for p in e.value.rejects)
    assert json.loads(state.read_text())["remaining"] == ["perch/three.patch"]
def test_continue_refuses_with_rej_left(...): ...         # raises, and nothing new is committed
def test_continue_resumes_after_fix(...): ...             # fix the file, delete the .rej, continue; three.patch and the generators are committed
def test_export_roundtrip(chromium_like, patch_dirs):
    apply, then amend one.patch's commit with an extra line, then export
    assert exported one.patch contains the extra line; there is no file for overlay or generators; series is unchanged
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement `series.py`, `patching.py` and the CLI commands.** `perch-build apply` uses `paths.src`, the tag from `version.json`, the repo's `patches/` and `overlay/`, and the generators registered in `cli.py`, an empty list until task 5. `perch-build export` rewrites the patch files.
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit.** `git commit -am "feat: add patch series apply, continue and export"`

### Task 4: GN args, build, and a baseline build

**Files:**
- Create: `build/args/common.gn`, `build/args/dev.gn`, `build/args/release.gn`, `tools/perchtools/gnargs.py`
- Modify: `tools/perchtools/cli.py` (add `build --config dev|release`)
- Test: `tests/test_gnargs.py`

**Interfaces:**
- Consumes: `Paths`, `run`.
- Produces:
  - `compose_args(repo: Path, config: Literal["dev", "release"], overrides: Mapping[str, str] = {}) -> str`. It parses `name = value` lines from `common.gn` and then the config file. Later keys replace earlier ones, keeping the first position, and overrides win.
  - `build(paths: Paths, config: str, run=run) -> Path`. It writes `args.gn` only when the content changed, so ninja doesn't redo work, then runs `gn gen` and `autoninja -C <out> <targets>`, and returns the out dir.
  - Targets: dev builds `chrome`. Release builds `chrome` and `chrome/installer/mac`, which produces `Perch Packaging/` with `sign_chrome.py`.

Exact args:

```
# common.gn
target_cpu = "arm64"
enable_widevine = true
ignore_missing_widevine_signing_cert = true   # until Google issues the VMP certificate (spec 5.2)
proprietary_codecs = true
ffmpeg_branding = "Chrome"
use_official_google_api_keys = false
enable_hangout_services_extension = false
enable_reporting = false
# dev.gn
is_debug = false
is_component_build = true
symbol_level = 0
# release.gn
is_official_build = true
is_component_build = false
symbol_level = 1
```

- [ ] **Step 1: Write the failing tests**

```python
def test_dev_args(repo): t = compose_args(repo, "dev"); assert "enable_widevine = true" in t and "is_component_build = true" in t
def test_release_overrides_order(repo): ...  # release has is_official_build = true and target_cpu = "arm64" exactly once
def test_overrides_win(repo): assert 'symbol_level = 2' in compose_args(repo, "release", {"symbol_level": "2"})
def test_build_skips_unchanged_args(tmp_path, recorder): ...  # second build(): args.gn mtime unchanged, gn gen and autoninja still called
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement `gnargs.py` and the CLI command.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Baseline dev build of unbranded Chromium with Perch's args. This takes 2 to 3 hours, so run it in the background.** Run `uv run perch-build apply && uv run perch-build build --config dev`. Then check the build headless: `out/Dev/Chromium.app/Contents/MacOS/Chromium --headless=new --user-data-dir="$(mktemp -d)" --dump-dom chrome://version | grep -c "<chromium version>"` should print at least 1. This proves the toolchain works before any patch exists.
- [ ] **Step 6: Commit.** `git commit -am "feat: add GN args and build command"`

### Task 5: Branding

**Files:**
- Create: `patches/perch/branding/branding-file.patch`, `user-data-dir.patch`, `safe-storage-name.patch` and `no-api-keys-infobar.patch`, plus `tools/perchtools/rename.py`, `branding/perch-mark.svg`, `branding/render-icons.swift` and the rendered icon files under `overlay/chrome/app/theme/chromium/`
- Modify: `patches/series`, `tools/perchtools/cli.py` (register the generator `("product-name", rename_product_strings)`)
- Test: `tests/test_rename.py`

**Interfaces:**
- Consumes: the task 3 generator contract.
- Produces:
  - `rename_text(text: str) -> str`. It replaces the whole word `Chromium` with `Perch`, but only inside `<message …>…</message>` bodies. It leaves alone the phrases `Chromium Authors`, `Chromium open source project`, `Chromium project` and `Chromium OS`, and everything outside message bodies (names, `desc` attributes, comments).
  - `rename_product_strings(src: Path) -> None`. It applies `rename_text` to every file `git -C src ls-files '*chromium_strings*.grd' '*chromium_strings*.grdp'` lists.

Translations (`.xtb`) are left alone. Changed English strings no longer match their translation ids, so other languages fall back to English for those strings. That is accepted for now: Perch is English-first, and a translated product name is later work.

The patches. Each is made in `src` with an edit and `perch-build export`, and each starts with a `# Perch: <why>` comment header:
- `branding-file.patch`, on `chrome/app/theme/chromium/BRANDING`: set `COMPANY_FULLNAME=Neel Satyavolu`, `COMPANY_SHORTNAME=Neel Satyavolu`, `PRODUCT_FULLNAME=Perch`, `PRODUCT_SHORTNAME=Perch`, `PRODUCT_INSTALLER_FULLNAME=Perch Installer`, `PRODUCT_INSTALLER_SHORTNAME=Perch Installer`, `COPYRIGHT=Copyright @LASTCHANGE_YEAR@ Neel Satyavolu and the Chromium Authors. All rights reserved.`, `MAC_BUNDLE_ID=co.xanom.perch`, `MAC_CREATOR_CODE=Prch` and `MAC_TEAM_ID=VTQW687WBQ`.
- `user-data-dir.patch`: the non-Google branch in `chrome/common/chrome_paths_mac.mm` uses `Perch` where it says `Chromium`. Find it with `grep -n '"Chromium"' chrome/common/chrome_paths_mac.mm`.
- `safe-storage-name.patch`: the Keychain service and account names under `components/os_crypt/` become `Perch Safe Storage` and `Perch`. Find them with `grep -rn "Chromium Safe Storage" components/os_crypt`.
- `no-api-keys-infobar.patch`: the startup check that shows "Google API keys are missing" never shows. Find it with `grep -rn "ShowIfNecessary\|GoogleApiKeysInfoBar" chrome/browser/ui/startup`.

The icon:
- `perch-mark.svg` is the Perch mark: a short horizontal bar (the perch) in ink `#FCFDFF`, with one accent dot `#4C8DFF` resting on its top edge right of centre. It sits on a canvas `#000000` rounded square at macOS icon proportions (824 px content on a 1024 grid, about 185 px corner radius).
- The design is flat: no gradient, glow or shadow (spec 6.2 and 6.5). **[builder call]** The owner may replace the SVG, and the pipeline only needs the file.
- `render-icons.swift` renders the SVG with `NSImage(contentsOf:)` into a 10-size iconset and runs `iconutil -c icns`. It writes `overlay/chrome/app/theme/chromium/mac/app.icns` plus every `product_logo_*.png` that `git -C src ls-files 'chrome/app/theme/chromium/*product_logo*.png' 'chrome/app/theme/*/chromium/product_logo*.png'` lists, each at that file's own pixel size (read it with `sips -g pixelWidth`).
- If the tree has `chrome/app/theme/chromium/mac/*.xcassets` or an `.icon` bundle, it renders the matching sizes there too.

- [ ] **Step 1: Write the failing tests**

```python
def test_renames_inside_message():
    assert rename_text('<message name="IDS_PRODUCT_NAME" desc="The Chromium name">Chromium</message>') == '<message name="IDS_PRODUCT_NAME" desc="The Chromium name">Perch</message>'
def test_keeps_credit_phrases():
    src = '<message name="IDS_ABOUT">Chromium is made possible by the Chromium open source project. Copyright The Chromium Authors.</message>'
    assert rename_text(src) == '<message name="IDS_ABOUT">Perch is made possible by the Chromium open source project. Copyright The Chromium Authors.</message>'
def test_whole_word_only(): assert "Chromiums" in rename_text("<message name=\"X\">Chromiums</message>")
def test_multiline_message(): ...    # a message body spanning 3 lines is renamed on every line
def test_comments_untouched(): ...   # <!-- Chromium --> outside a message is unchanged
def test_generator_touches_only_listed_files(chromium_like): ...  # only *chromium_strings*.grd(p) files change
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement `rename.py` and register the generator.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Make the four patches, then export them.** In `src`, make each edit and commit it with its patch path as the message. Then run `uv run perch-build export`, add the paths to `patches/series`, and run `uv run perch-build apply` to confirm the series replays cleanly.
- [ ] **Step 6: Render the icons.** Run `swift branding/render-icons.swift ~/chromium-perch/src`. `iconutil -c iconset overlay/chrome/app/theme/chromium/mac/app.icns -o /tmp/x.iconset` should round-trip.
- [ ] **Step 7: Dev build.** Run `uv run perch-build apply && uv run perch-build build --config dev`. Then check:
  - `out/Dev/Perch.app` exists, and `defaults read "$PWD/out/Dev/Perch.app/Contents/Info" CFBundleIdentifier` prints `co.xanom.perch`.
  - Headless `--dump-dom chrome://version` output contains `Perch` and doesn't contain `>Chromium<`.
  - Review Focus 3: run `strings` on `out/Dev/Perch.app/Contents/Frameworks/Perch Framework.framework/Versions/Current/Perch Framework`, or on the component build's `.dylib` files under `out/Dev`. The output has `Perch Safe Storage` and has no `Chromium Safe Storage`. A headless run with no `--user-data-dir` creates `~/Library/Application Support/Perch` and does not touch `~/Library/Application Support/Chromium`: compare its modification time before and after, then delete the new Perch folder. If headless mode turns out to use a temporary profile, the `strings` check alone counts here, and the owner check in task 9 covers the folder.
- [ ] **Step 8: Design review (spec 6.9).** Run the unslop checks on the mark at 16, 32, 128 and 1024 px. Render the PNGs off-screen and read them with the Read tool. The bar and dot must stay legible at 16 px. Record the result in the commit body.
- [ ] **Step 9: Commit.** `git add -A && git commit -m "feat: brand the build as Perch"`

### Task 6: Sparkle updater inside the browser

**Files:**
- Create: `overlay/chrome/browser/perch/perch_updater_mac.h` and `overlay/chrome/browser/perch/perch_updater_mac.mm`, plus `patches/perch/updater/start-updater.patch`
- Modify: `patches/series`

**Interfaces:**
- Produces:
  - `namespace perch { void StartUpdater(); }`, called once from `-[AppController applicationDidFinishLaunching:]` in `chrome/browser/app_controller_mac.mm`.
  - The patch also adds the two overlay files to the macOS `sources` of `chrome/browser/BUILD.gn` (the block holding `app_controller_mac.mm`).

Behaviour:
1. Look for `Contents/Frameworks/Sparkle.framework` under `base::apple::OuterBundle()`. If it's missing (dev builds), or `-[NSBundle load]` fails, or `NSClassFromString(@"SPUStandardUpdaterController")` is nil, return and do nothing.
2. Otherwise create the controller with `initWithStartingUpdater:YES updaterDelegate:nil userDriverDelegate:nil` and keep a strong static reference. Declare the selector in a small `@protocol` in the `.mm`, so nothing links against Sparkle.
3. Insert the item `Check for Updates…` into the app menu (`[[NSApp mainMenu] itemAtIndex:0].submenu`) right after the first item ("About Perch"). Its target is the controller and its action is `checkForUpdates:`.

The check interval and feed come from Info.plist keys that task 7 writes. A settings off switch comes in plan 2 with the allowed-connections list, and a policy in plan 8.

- [ ] **Step 1: Write the files and the patch.** Make the change in `src`, commit it as `perch/updater/start-updater.patch`, run `perch-build export`, and add it to `series`.
- [ ] **Step 2: Dev build.** Run `uv run perch-build build --config dev`. Success means it compiles and links with no new warnings in `perch_updater_mac.mm`.
- [ ] **Step 3: Review Focus 4.** The dev build has no Sparkle, so run it headless with `--dump-dom about:blank` and confirm it exits 0. Headless mode skips `AppController`, so the GUI side of this check (no menu item and no crash without Sparkle) is part of the owner acceptance in task 9.
- [ ] **Step 4: Commit.** `git add -A && git commit -m "feat: start Sparkle when it is bundled"`

### Task 7: Packaging: Sparkle, Info.plist, signing, DMG, notarization

**Files:**
- Create: `build/sparkle.json`, `tools/perchtools/{plist,sparkle,package}.py`, `scripts/with-apple-creds.sh`, `scripts/maintainer.local.example`
- Modify: `tools/perchtools/cli.py` (add `package --mode release|adhoc`)
- Test: `tests/test_plist.py`, `tests/test_sparkle.py`, `tests/test_package.py`

**Interfaces:**
- Consumes: `Paths`, `run`, `redact`, `VersionInfo`, `bundle_versions`, and the release build from task 4.
- Produces:
  - `sparkle_keys(feed_url: str, public_key: str) -> dict[str, object]`.
  - `update_plist(path: Path, values: Mapping[str, object]) -> None` (uses plistlib and preserves the other keys).
  - `SparklePin(version: str, url: str, sha256: str)`, `load_pin(path: Path) -> SparklePin`, `fetch_sparkle(pin, cache: Path, download: Callable[[str, Path], None]) -> Path` (raises `ChecksumError` on mismatch and deletes the bad file), `embed_sparkle(app: Path, sparkle_root: Path) -> None` and `sign_sparkle(app: Path, identity: str, run=run) -> None`.
  - `package(paths: Paths, info: VersionInfo, mode: Literal["release", "adhoc"], creds: AppleCreds | None, run=run) -> Path`, which returns the DMG path.
  - `AppleCreds(identity: str, api_key_id: str, api_issuer: str, api_key_path: Path)`, built by `creds_from_env(env) -> AppleCreds`. It reads `APPLE_SIGNING_IDENTITY`, `APPLE_API_KEY`, `APPLE_API_ISSUER` and `APPLE_API_KEY_PATH`, the names agmux's loader exports, and raises a clear error naming any that are missing.

Values:
- Feed URL: `https://github.com/neelsatyavolu/perch/releases/latest/download/appcast.xml`.
- `sparkle_keys` returns `SUFeedURL`, `SUPublicEDKey`, `SUEnableAutomaticChecks: True`, `SUScheduledCheckInterval: 86400` and `SUAutomaticallyUpdate: True`. The last one is a **[builder call]**: updates download in the background and install on quit, so the 72-hour security fixes (spec 12.4) reach people.
- The public key lives in `build/sparkle.json` as `public_ed_key`. The private key never touches the repo.

Sparkle signing order, from Sparkle's docs for apps outside the Mac App Store sandbox. Use `--force --options runtime --timestamp --sign <identity>` throughout:
1. `Versions/B/XPCServices/Installer.xpc`
2. `Versions/B/XPCServices/Downloader.xpc` with `--preserve-metadata=entitlements`
3. `Versions/B/Autoupdate`
4. `Versions/B/Updater.app`
5. the framework itself

`package(mode="release")` runs these steps in order:
1. Copy `out/Release/Perch.app` and `out/Release/Perch Packaging` to `dist/stage/`.
2. `embed_sparkle`, then `sign_sparkle`.
3. `update_plist(app/Contents/Info.plist, bundle_versions(info) | sparkle_keys(...))`.
4. `python3 "dist/stage/Perch Packaging/sign_chrome.py" --input dist/stage --output dist/signed --identity <identity> --disable-packaging --notarize none`.
5. `hdiutil create -volname Perch -srcfolder <dir with Perch.app and an /Applications symlink> -fs APFS -format ULFO dist/Perch-<perch>.dmg`, then `codesign` the DMG.
6. `xcrun notarytool submit <dmg> --key <path> --key-id <id> --issuer <issuer> --wait`, then `xcrun stapler staple` on the DMG.
7. Verify: `codesign --verify --deep --strict` on the app, `spctl -a -t exec -vv` on the app, and `xcrun stapler validate` on the DMG.

`mode="adhoc"` runs steps 1 to 3 and then `codesign --force --deep --sign -`. It skips notarization and leaves Sparkle out, because an ad-hoc build can't verify updates.

Secrets (Review Focus 5): every `run` in `package` passes `secrets=[creds.api_key_id, creds.api_issuer]`. The `.p8` key file is created by the agmux loader, and `scripts/with-apple-creds.sh` deletes it in an `EXIT` trap, as agterm's loader does.

**Owner step, done once:** create the Sparkle key without printing the private key. Run Sparkle's `bin/generate_keys --account perch`, which stores the key in the login Keychain and prints only the public key. Put the public key in `build/sparkle.json`. Then save the private key to 1Password: `bin/generate_keys --account perch -x "$TMPDIR/k" && op --account E3OXZANXQRDOBNXQMPXZ6YBHTY document create "$TMPDIR/k" --title "Perch Sparkle EdDSA key" --vault Private; rm -P "$TMPDIR/k"`. Set `PERCH_SPARKLE_KEY_REF` in `scripts/maintainer.local`.

- [ ] **Step 1: Write the failing tests**

```python
def test_sparkle_keys():
    k = sparkle_keys("https://x/appcast.xml", "PUB")
    assert k == {"SUFeedURL": "https://x/appcast.xml", "SUPublicEDKey": "PUB", "SUEnableAutomaticChecks": True, "SUScheduledCheckInterval": 86400, "SUAutomaticallyUpdate": True}
def test_update_plist_preserves_other_keys(tmp_path): ...  # CFBundleIdentifier survives; CFBundleVersion becomes "1"
def test_fetch_sparkle_rejects_bad_checksum(tmp_path):
    with pytest.raises(ChecksumError): fetch_sparkle(SparklePin("2.7.0", "u", "00"*32), tmp_path, write_bytes(b"x"))
    assert not any(tmp_path.iterdir())
def test_sign_sparkle_order(tmp_path, recorder):
    sign_sparkle(app_with_fake_sparkle, "ID", recorder)
    assert [c[-1].split("Sparkle.framework/")[-1] for c in recorder.calls] == ["Versions/B/XPCServices/Installer.xpc", "Versions/B/XPCServices/Downloader.xpc", "Versions/B/Autoupdate", "Versions/B/Updater.app", ""]
def test_package_release_runs_steps_in_order(staged_build, recorder): ...
    # command names in order: codesign (sparkle) x5, python3 sign_chrome.py, hdiutil create, codesign (dmg), xcrun notarytool, xcrun stapler staple, codesign --verify, spctl, xcrun stapler validate
def test_package_never_logs_secrets(staged_build, capsys): ...   # Review Focus 5: key id and issuer never appear on stderr
def test_adhoc_skips_notarize_and_sparkle(staged_build, recorder): ...
def test_creds_from_env_names_missing(): ...    # an empty env raises an error whose message names all four variables
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement the three modules, the CLI command and the scripts.** `scripts/with-apple-creds.sh <cmd…>` sources `scripts/maintainer.local` and the agmux loader, then runs the command. Use the pinned Sparkle 2 version that is current on the day of implementation, take its sha256 from the GitHub release, and record both in `build/sparkle.json`.
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Release build and package. Allow 3 to 4 hours for the build.** Run `uv run perch-build build --config release && scripts/with-apple-creds.sh uv run perch-build package --mode release`. Success means the step 7 checks print `valid on disk`, `accepted source=Notarized Developer ID` and `The validate action worked!`.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat: sign, notarize and package Perch with Sparkle"`

### Task 8: Release

**Files:**
- Create: `tools/perchtools/release.py`
- Modify: `tools/perchtools/cli.py` (add `release [--dry-run]`)
- Test: `tests/test_release.py`

**Interfaces:**
- Consumes: `package()`'s DMG, `VersionInfo`, and `run`.
- Produces:
  - `preflight(repo: Path, src: Path, info: VersionInfo, tag_exists: Callable[[str], bool], run=run) -> list[str]`, which returns the reasons not to release.
  - `appcast(dmg: Path, out: Path, key_ref: str, info: VersionInfo, run=run) -> Path`.
  - `publish(info: VersionInfo, dmg: Path, appcast: Path, notes: str, run=run) -> None`.

Preflight refuses when:
- the Perch repo has uncommitted changes;
- `git -C src merge-base --is-ancestor <info.chromium> HEAD` fails, which means the build doesn't sit on the pinned tag;
- the patch commits on `perch` differ from the repo's `patches/`, checked by running `export_series(src, tag, <temp dir>)` and comparing the result with `patches/` file by file;
- tag `v<perch>` already exists on GitHub;
- `build` is not greater than the `sparkle:version` in the published appcast.

`appcast` does the following:
1. `op read <key_ref>` into a 0600 file in a `tempfile.TemporaryDirectory` (deleted on exit).
2. `generate_appcast --ed-key-file <file> --download-url-prefix https://github.com/neelsatyavolu/perch/releases/download/v<perch>/ <dir holding the DMG>`, run as `run(..., secrets=[])` because the key is only in the file.

`publish` runs `gh release create v<perch> --repo neelsatyavolu/perch --title "Perch <perch>" --notes <notes> <dmg> <appcast>`. The notes name the Chromium version and list `patches/series`. That patch list is what spec 12.4 asks every release to publish, and the SBOM arrives in plan 8. `--dry-run` writes everything to `dist/release/` and publishes nothing.

- [ ] **Step 1: Write the failing tests**

```python
def test_preflight_clean_passes(repo_ok, src_ok): assert preflight(repo_ok, src_ok, INFO, lambda t: False, recorder) == []
def test_preflight_dirty_repo(...): ...       # reason mentions "uncommitted"
def test_preflight_wrong_chromium(...): ...   # reason names both versions
def test_preflight_stale_patches(...): ...    # src commits differ from patches/: "run perch-build export"
def test_preflight_tag_exists(...): ...       # reason names v0.1.0
def test_preflight_build_not_higher(...): ... # published sparkle:version 3, local build 3: refused
def test_appcast_key_file_removed(tmp_path, recorder): ...  # the key file path recorded in the command no longer exists afterwards
def test_dry_run_publishes_nothing(...): ...  # no "gh release create" call
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement `release.py` and the CLI command.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Dry run.** Run `scripts/with-apple-creds.sh uv run perch-build release --dry-run`. Success means `dist/release/appcast.xml` has one `<item>` with `sparkle:version` 1, `sparkle:shortVersionString` 0.1.0 and an `sparkle:edSignature` attribute.
- [ ] **Step 6: Commit.** `git commit -am "feat: add release preflight, appcast and publish"`

### Task 9: Rebase command, docs, first release and owner acceptance

**Files:**
- Modify: `tools/perchtools/cli.py` (add `rebase [--security] [<version>]`)
- Create: `docs/building.md`, `docs/rebasing.md`, `docs/drm-status.md`
- Test: `tests/test_cli_rebase.py`

**Interfaces:**
- Consumes: `latest_stable_mac`, `bump`, `checkout`, `apply_series` and `continue_series`.
- Produces: `rebase(paths: Paths, repo: Path, kind: Literal["rebase", "security"], version: str | None, run=run) -> VersionInfo`. With no version it uses `latest_stable_mac`. It writes the bumped `version.json` first, then runs checkout and apply. On `PatchFailed` it prints the patch name, the `.rej` files and the next command (`perch-build apply --continue`), and exits 2.

The docs:
- `docs/building.md`: doctor, checkout, apply, the dev build, the headless check, and the ad-hoc package for contributors without the certificate.
- `docs/rebasing.md`: the commit model from task 3, what to do on a failed patch (fix it, delete the `.rej`, run `apply --continue`, then `export`), the 4-weekly rebase, and the security path. The security path is `rebase --security`, a release build, and a release within 72 hours of Google's (spec 12.4).
- `docs/drm-status.md`: a table with columns service, plays, quality and date, and one row each for Netflix, Hulu, Disney+, Prime Video, Peacock, Max and F1 TV. All cells start empty, and plan 2 fills them in (spec 5.2).

- [ ] **Step 1: Write the failing tests**

```python
def test_rebase_writes_version_before_checkout(tmp_path, recorder): ...   # version.json shows 0.2.0, build+1, new chromium; then checkout and apply are called
def test_security_rebase_bumps_patch(tmp_path, recorder): ...
def test_rebase_failed_patch_exits_2_with_next_step(tmp_path, capsys): ... # stderr contains the patch name and "perch-build apply --continue"
```

- [ ] **Step 2: Run them and confirm they fail.** Then implement, and confirm they pass.
- [ ] **Step 3: Write the three docs and commit.** `git add -A && git commit -m "feat: add rebase command and build docs"`
- [ ] **Step 4: Owner gate. Ask before you continue.** Ask the owner to approve creating the public repo and publishing. Then run `gh repo create neelsatyavolu/perch --public --source . --push` and `scripts/with-apple-creds.sh uv run perch-build release`.
- [ ] **Step 5: Owner acceptance. The owner does this by hand, because it needs the GUI:**
  - Install `Perch-0.1.0.dmg` and launch it. Gatekeeper opens it with no warning.
  - About Perch shows 0.1.0, and the app menu has "Check for Updates…".
  - `~/Library/Application Support/Perch` exists, and Chrome's and Chromium's profiles are untouched.
  - A Chrome Web Store extension (for example uBlock Origin Lite) installs.
  - `chrome://components` lists the Widevine Content Decryption Module with a version after a minute.
- [ ] **Step 6: Update test.** Run `uv run perch-build version --bump perch` (0.1.1, build 2), commit, release, then click "Check for Updates…" in the installed 0.1.0. It should offer 0.1.1, install it on relaunch, and About should show 0.1.1. The owner records the results in the PR description, or in `docs/drm-status.md` for Widevine.
- [ ] **Step 7: Owner action.** Submit the Widevine VMP application (roadmap owner action 4).

---

## Spec coverage

| Spec item | Task |
|---|---|
| 5.1 pinned Stable tag, patch series plus added dirs, applied by script | 2, 3 |
| 5.1 rebase every Stable and fast security releases | 9 (`rebase`, `--security`), 1 (`bump`) |
| 5.1 privacy patches and allowed connections | plan 2. This plan only adds Sparkle's daily check |
| 5.1 build machine, local release builds | 2 (doctor), 4, 7 |
| 5.1 Developer ID, notarized, Sparkle from GitHub Releases, EdDSA key in 1Password | 6, 7, 8 |
| 5.1 bundle id `co.xanom.perch` | 5 |
| 5.1 `perch://` scheme | plan 2 |
| 5.2 `enable_widevine=true`, component updater, VMP application, `docs/drm-status.md` | 4, 9 |
| 6.9 design review on UI steps | 5, step 8 (the icon is the only UI here) |
| 11.1 "Perch Safe Storage" | 5 |
| 12.4 patch list with each release, signed and notarized, EdDSA-signed updates | 7, 8 |
| 12.4 SBOM, `SECURITY.md` | plan 8 |
| 13 speed: PGO profiles in official builds | 2 (`checkout_pgo_profiles`), 4 |
| 16 BSD and MIT licences and credits | 1 (LICENSE), 5 (patch headers) |
| 16 no GUI driving | Global Constraints, owner steps in 9 |
