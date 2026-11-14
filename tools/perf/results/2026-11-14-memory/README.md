# Start, page load and memory, 2026-11-14

`bun tools/perf/measure.ts <binary> --tabs 10` on an M5 Max (18 cores, 64 GB), on AC power, headless,
fresh profile, median of 3 launches. Start is launch to DevTools listening; page load is one local
page with layout, canvas and script work; memory is the physical footprint of every process of the
run (Perch's includes perchd, started with `--perch-agent-in-headless`, own PERCH_HOME), idle after
60 s and then with 10 more tabs of the same page.

| Browser | Start | Page load | Idle | Processes | With 10 tabs |
|---|---|---|---|---|---|
| Perch 0.3.4 (with agent) | 225 ms | 43 ms | 254 MB | 8 | 1176 MB |
| Perch 0.3.4 (`--perch-no-agent`) | 221 ms | 42 ms | 205 MB | 7 | 1135 MB |
| Chrome 157.0.8103.51 | 235 ms | 36 ms | 181 MB | 9 | 903 MB |
| Brave 1.99.57 | 237 ms | 38 ms | 191 MB | 6 | 867 MB |
| Chrome for Testing 158.0.8127.18 (Perch's Chromium) | 253 ms | 37 ms | 206 MB | 8 | 923 MB |

Idle, Perch's browser processes use what its Chromium does (205 vs 206 MB); the agent (perchd)
adds about 49 MB, inside the 1.0 target of 60 MB for Perch's additions. With 10 tabs Perch uses about
250 MB more than its Chromium, about 25 MB a tab: the bundled extensions' work in every page (see
../2026-11-14-caveatly-optin).
