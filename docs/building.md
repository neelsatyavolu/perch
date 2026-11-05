# Building Perch

Perch is Chromium plus a series of patches. The `perch-build` tool in this repo checks out Chromium, applies Perch's changes, builds, signs and releases. You need an Apple silicon Mac with Xcode, Python 3.12 or newer, [uv](https://docs.astral.sh/uv/), and about 120 GB free.

## First build

```sh
uv sync
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git ~/depot_tools
uv run perch-build doctor      # checks the Mac
uv run perch-build checkout    # Chromium at the version in version.json, about an hour
uv run perch-build apply       # Perch's overlay, patches and generated changes
uv run perch-build build       # dev build, 2 to 3 hours the first time
```

Chromium goes to `~/chromium-perch` and depot_tools to `~/depot_tools`. Set `PERCH_CHROMIUM_DIR` or `PERCH_DEPOT_TOOLS` to use other folders. The build lands in `~/chromium-perch/src/out/Dev/Perch.app`.

Check a build without opening a window:

```sh
out/Dev/Perch.app/Contents/MacOS/Perch --headless=new --user-data-dir="$(mktemp -d)" --dump-dom chrome://version
```

## Packaging

Anyone can make an unsigned DMG:

```sh
uv run perch-build build --config release
uv run perch-build package --mode adhoc
```

An ad-hoc build has no Sparkle updates and macOS warns before opening it.

Signed and notarized packages need the maintainer's Developer ID. Copy `scripts/maintainer.local.example` to `scripts/maintainer.local`, fill it in, and run:

```sh
scripts/with-apple-creds.sh uv run perch-build package --mode release
scripts/with-apple-creds.sh uv run perch-build release --dry-run   # writes dist/release, publishes nothing
scripts/with-apple-creds.sh uv run perch-build release
```

`with-apple-creds.sh` loads the certificate into a temporary keychain and removes it, and the notarization key, when the command ends.

### The Sparkle key (once)

Updates are signed with an EdDSA key. Create it without printing the private key, using the Sparkle tools that `perch-build release` downloads to `dist/cache/sparkle-<version>/bin`:

```sh
bin/generate_keys --account perch          # stores the key in the login Keychain, prints the public key
bin/generate_keys --account perch -x "$TMPDIR/k"
op --account <your account> document create "$TMPDIR/k" --title "Perch Sparkle EdDSA key" --vault Private
rm -P "$TMPDIR/k"
```

Put the public key in `build/sparkle.json` as `public_ed_key`, and the 1Password reference in `scripts/maintainer.local` as `PERCH_SPARKLE_KEY_REF`.

## Versions

`version.json` holds the Perch version, a build number and the Chromium version. Sparkle orders releases by the build number alone, so every release raises it.

```sh
uv run perch-build version                    # show
uv run perch-build version --bump perch       # Perch-only release: 0.1.0 → 0.1.1
```

Moving to a new Chromium is covered in [rebasing.md](rebasing.md).

## Tests

```sh
uv run pytest --cov=perchtools
```
