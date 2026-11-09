"""perch-build snapshot: renders the browser window off-screen, one PNG per state, for design review.

Drives the --perch-chrome-snapshot hook in chrome/browser/perch/snapshot/chrome_snapshot.cc. Perch
runs headless in a throwaway profile, so the person's own profile and screen are never touched.
"""

from __future__ import annotations

from pathlib import Path

DEFAULT_STATES = ("default",)


def snapshot_command(app: Path, repo: Path, out_dir: Path, profile: Path, states: list[str],
                     extensions: Path | None) -> list[str]:
    """The Perch command line that writes <out_dir>/<state>.png for each state, then quits.
    Dev builds read the pages and side UI from the repo's dist folders, so those are passed too."""
    cmd = [
        str(app / "Contents" / "MacOS" / "Perch"),
        "--headless=new",
        f"--user-data-dir={profile}",
        "--no-first-run",
        f"--perch-chrome-snapshot={out_dir}",
        f"--perch-snapshot-states={','.join(states or DEFAULT_STATES)}",
        f"--perch-pages-dir={repo / 'ui-pages' / 'dist'}",
        f"--perch-ui-dir={repo / 'ui' / 'dist'}",
    ]
    if extensions is not None:
        cmd.append(f"--perch-extensions-dir={extensions}")
    return cmd


def written(out_dir: Path, states: list[str]) -> tuple[list[Path], list[str]]:
    """The PNGs that exist, and the states that produced none."""
    found, missing = [], []
    for state in states or DEFAULT_STATES:
        path = out_dir / f"{state}.png"
        (found if path.is_file() else missing).append(path if path.is_file() else state)
    return found, missing
