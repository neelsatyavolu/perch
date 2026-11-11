---
name: youtube
description: Use YouTube - search videos, read a video's transcript, description and comments, browse a channel. Use for tasks about what a video says, finding videos, or a channel's uploads.
---

# YouTube

## Go straight to the page

- Search: `https://www.youtube.com/results?search_query=<query>`
- A video: `https://www.youtube.com/watch?v=<id>`; at a time, add `&t=<seconds>s`
- A channel's uploads: `https://www.youtube.com/@<handle>/videos`

## What a video says

Read the transcript, not the video. On the watch page, click the description's "more" button, then "Show transcript" (it only appears once the description is open), then read the transcript panel. Pull it in one call:

```js
[...document.querySelectorAll("transcript-segment-view-model, ytd-transcript-segment-renderer")].map((s) => s.innerText.replace(/\s+/g, " ").trim()).join("\n")
```

Each line starts with its timestamp.

If a video has no transcript, say so and use the description and chapters instead. Never guess what a video says from its title.

## Notes

- Comments load only after scrolling below the video. Scroll, then read them.
- View counts and dates on result pages are rounded ("1.2M views", "3 weeks ago"); the watch page's description has the exact figures.
- An ad may play first; the page is still readable while it does.
