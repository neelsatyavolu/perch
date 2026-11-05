/**
 * Functions run in pages through chrome.scripting.executeScript. Chrome serialises them, so each is
 * self-contained. Called from a click, menu or shortcut, they carry the user's gesture, which is
 * what picture in picture needs.
 */

export function togglePictureInPicture(): string {
  if (document.pictureInPictureElement) {
    void document.exitPictureInPicture();
    return "left";
  }
  const videos = [...document.querySelectorAll("video")];
  const area = (v: HTMLVideoElement) => v.getBoundingClientRect().width * v.getBoundingClientRect().height;
  const playing = videos.filter((v) => !v.paused && !v.ended && v.readyState >= 2).sort((a, b) => area(b) - area(a));
  const video = playing[0] ?? (window === top ? videos.filter((v) => area(v) > 0).sort((a, b) => area(b) - area(a))[0] : undefined);
  if (!video || video.disablePictureInPicture) return "none";
  void video.requestPictureInPicture().catch(() => undefined);
  return "entered";
}

export function setPlaybackRate(src: string, rate: number): void {
  const videos = [...document.querySelectorAll("video")];
  const video =
    videos.find((v) => src && (v.currentSrc === src || v.src === src)) ??
    videos.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  if (video) video.playbackRate = rate;
}

export async function pictureInPicture(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: togglePictureInPicture });
}
