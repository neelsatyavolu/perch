# What the bundled Caveatly costs, and what its opt-in buys back (2026-11-14)

Chrome for Testing 158.0.8127.18 (the Chromium Perch 0.3.4 is built from), on an M5 Max on AC power.
Caveatly 0.2.3 as Perch bundles it (same files and manifest, `caveatly_embed` included), loaded
unpacked; "opt-in" is the same build plus two commits on ~/Documents/GitHub/caveatly branch
perf/skip-detached-nodes, with `"cosmetics"` added to `caveatly_embed.hide`, which drops Caveatly's
element-hiding script (adblock.js in every frame) and keeps its network blocking and scriptlets.

| Chrome for Testing 158 | Speedometer 3.1 (n=2) | MotionMark 1.3.1, 60 fps (n=1) | Memory, 10 tabs (n=3) |
|---|---|---|---|
| no extensions | 62.65 | 10547 | 923 MB (2026-11-14-memory) |
| + Caveatly as bundled | 52.70 | 6504 | 1142 MB |
| + Caveatly, cosmetics hidden | 61.80 | 11185 | 1082 MB |
| + Perch's built-in extension | | | 984 MB |
| + both, Caveatly's cosmetics hidden | | | 1172 MB |

The full matrix (2026-11-14-matrix, n=3) agrees: Caveatly as bundled 48.5 Speedometer and 6832
MotionMark against 62.7 and 11197 without it. The perf commit alone (skip elements already removed)
gives 53.7 Speedometer and no MotionMark change. Perch's own built-in extension costs about 2% on
Speedometer (61.8 vs 62.9, 2026-11-14 A/B runs not kept).

Perch already hides EasyList's generic selectors with plain CSS (extension/src/cosmetic), which also
covers elements added later, so Caveatly's element hiding repeats that work inside Perch. Memory
numbers are noisier than speed: an MV3 worker that has gone to sleep before the 60 s idle sample
weighs nothing.
