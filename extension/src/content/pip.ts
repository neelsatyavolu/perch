/**
 * Content script: when the tab is hidden while a video plays with sound, move it into picture in
 * picture; bring it back when the tab is shown again. Muted background videos are left alone.
 *
 * Chromium only grants requestPictureInPicture() with a recent user gesture, so in a stock build
 * this succeeds only shortly after the user interacted with the page. The Perch build turns on
 * Chromium's browser-initiated automatic picture in picture, which covers the rest natively; the
 * keyboard command and the video menu work everywhere because they carry the user's gesture.
 */

import { isPlaying, mainVideo } from "../media/video";

let ours: HTMLVideoElement | null = null;

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    const video = mainVideo(document);
    if (!video || !isPlaying(video) || video.muted || video.volume === 0 || video.disablePictureInPicture) return;
    if (document.pictureInPictureElement || video.videoWidth === 0) return;
    video.requestPictureInPicture().then(
      () => (ours = video),
      () => undefined,
    );
    return;
  }
  if (ours && document.pictureInPictureElement === ours) void document.exitPictureInPicture().catch(() => undefined);
  ours = null;
});
