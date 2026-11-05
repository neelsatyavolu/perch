/** Picks the video a media command is about. Shared by the content scripts and injected functions. */

export function isPlaying(video: HTMLVideoElement): boolean {
  return !video.paused && !video.ended && video.readyState >= 2;
}

/** The playing video if there is one, else the largest visible one. */
export function mainVideo(doc: Document): HTMLVideoElement | null {
  const videos = [...doc.querySelectorAll("video")].filter((v) => v.isConnected);
  const area = (v: HTMLVideoElement) => {
    const r = v.getBoundingClientRect();
    return r.width * r.height;
  };
  const playing = videos.filter(isPlaying).sort((a, b) => area(b) - area(a));
  if (playing[0]) return playing[0];
  return videos.filter((v) => area(v) > 0).sort((a, b) => area(b) - area(a))[0] ?? null;
}

export const MIN_RATE = 0.25;
export const MAX_RATE = 4;
export const RATE_STEP = 0.25;

/** The next rate for `[` (down) or `]` (up), kept on the 0.25 grid and within 0.25–4. */
export function stepRate(current: number, direction: -1 | 1): number {
  const units = current / RATE_STEP;
  const next = direction > 0 ? Math.floor(units + 1e-9) + 1 : Math.ceil(units - 1e-9) - 1;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, next * RATE_STEP));
}
