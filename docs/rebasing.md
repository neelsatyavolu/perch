# Rebasing on a new Chromium

## How Perch's changes are stored

- `overlay/`: whole files copied into the Chromium tree, such as icons and new source files.
- `patches/`: unified diffs, applied in the order `patches/series` lists. Each starts with a `# Perch: <why>` comment. Patches borrowed from other forks keep their licence and credit in that comment.
- Generated changes: steps the tool runs on every apply, such as renaming "Chromium" to "Perch" in the product strings.

`perch-build apply` resets the tree to the Chromium tag and makes one commit for each change, on a local branch called `perch`:

```
perch-generated: product-name          ← generators, newest
perch/updater/start-updater.patch
perch/branding/branding-file.patch     ← one commit per patch, in series order
perch-generated: overlay               ← oldest, right on top of the tag
```

`perch-build export` writes the patch commits back to `patches/`. Commits that start with `perch-generated:` are never exported. Apply is safe to repeat: it resets first, and it leaves `out/` alone.

## Changing a patch

Edit the files in `~/chromium-perch/src`, amend the patch's commit, or add a new commit whose message is the patch's path (for example `perch/branding/new-thing.patch`). Then run `uv run perch-build export`, add new patches to `patches/series`, and commit in this repo.

## The monthly rebase

Chromium ships a new Stable about every four weeks.

```sh
uv run perch-build rebase            # latest Stable; bumps 0.1.x to 0.2.0
```

It writes `version.json`, checks out the new tag and applies the series. When a patch no longer applies, it stops and prints the patch name and the `.rej` files that hold the parts it couldn't place. Then:

1. Make the change by hand in `~/chromium-perch/src`, using the `.rej` file as the guide.
2. Delete the `.rej` files.
3. Run `uv run perch-build apply --continue`. It commits the fix as that patch and carries on.
4. When everything applies, run `uv run perch-build export`, build, test, and commit.

## Security releases

When Google ships a Chrome security fix, Perch ships within 72 hours:

```sh
uv run perch-build rebase --security 158.0.8127.30
uv run perch-build build --config release
scripts/with-apple-creds.sh uv run perch-build package --mode release
scripts/with-apple-creds.sh uv run perch-build release
```

Point releases rarely touch Perch's patches, so this usually applies cleanly.
