---
name: github
description: Work on github.com - find repositories, read code and files, search and file issues, review pull requests and releases. Use for any task that involves a GitHub repository or account.
---

# GitHub

## Go straight to the page

- Repository: `https://github.com/<owner>/<repo>`
- A file: `https://github.com/<owner>/<repo>/blob/<branch>/<path>`; the plain text is at `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>`
- Issues with filters: `https://github.com/<owner>/<repo>/issues?q=is:issue+is:open+label:bug+author:<user>`
- Pull requests: `https://github.com/<owner>/<repo>/pulls?q=is:pr+is:open+review-requested:@me`
- One PR's changes: `https://github.com/<owner>/<repo>/pull/<n>/files`
- Releases: `https://github.com/<owner>/<repo>/releases` (latest: `/releases/latest`)
- Commits on a branch: `https://github.com/<owner>/<repo>/commits/<branch>`
- Search repositories: `https://github.com/search?q=<query>&type=repositories` (code search, `type=code`, needs the user signed in)

## Read facts quickly

For counts and metadata (stars, forks, open issues, default branch, licence, latest release), the public API answers without opening a page: open `https://api.github.com/repos/<owner>/<repo>` or `https://api.github.com/repos/<owner>/<repo>/releases/latest` and read the JSON. It allows 60 unauthenticated requests an hour, so use pages when you need many.

Star and fork counts on pages are rounded ("1.2k"); use the API for exact numbers.

## File an issue

`https://github.com/<owner>/<repo>/issues/new?title=<title>&body=<body>` opens a prefilled form (URL-encode both). Repositories with issue templates show a chooser first; pick the template that fits, then fill it. Submitting waits for the user's approval in Guard and Ask modes.

## Notes

- Large files and long diffs load lazily; scroll or click "Load diff" before reading them.
- A 404 on a private repository usually means the user is signed in to a different account, not that it does not exist. Say so instead of guessing.
