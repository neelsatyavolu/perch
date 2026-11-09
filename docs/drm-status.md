# Protected video playback

Perch is built with Widevine, and Chromium's component updater downloads Google's Widevine module on first run. Some services also check for a Verified Media Path (VMP) signature, which Perch doesn't have yet (application pending). Without it a service may play normally, play at lower quality, or refuse.

The owner tests each service by hand in a signed build and records the result here.

| Service | Plays | Quality | Perch version | Date |
|---|---|---|---|---|
| Netflix | | | | |
| Hulu | | | | |
| Disney+ | | | | |
| Prime Video | | | | |
| Peacock | | | | |
| Max | | | | |
| F1 TV | | | | |
