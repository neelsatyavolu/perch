---
name: google-docs
description: Read and edit Google Docs and Sheets (docs.google.com) in the user's signed-in account. Use for any task that reads, summarises or changes a Google Doc or Sheet.
---

# Google Docs and Sheets

## Read without the editor

The editor draws text on a canvas, so its snapshot is thin. Read the plain export instead, in the signed-in browser:

- A Doc as text: `https://docs.google.com/document/d/<id>/export?format=txt`
- A Sheet tab as CSV: `https://docs.google.com/spreadsheets/d/<id>/export?format=csv&gid=<gid>` (`gid` is in the sheet's URL after `#gid=`; 0 is the first tab)

The `<id>` is the long part of the address after `/d/`. Open the export with navigate and read the page.

## Edit

- Docs: click where the text goes, then use type_text. Use the menus (Format, Insert) by their labels rather than keyboard shortcuts.
- Sheets: click the Name box (top left), type the cell (`B7`) and press Enter to jump to it, then type_text the value and press Enter or Tab. A value starting with `=` is a formula.
- After editing, read the export again to check the change landed.

## Notes

- "You need access" means the user's account cannot open the file; say so rather than retrying.
- If the user has several Google accounts, the account number is in the URL (`/u/1/`). Keep the one the link uses.
- Sharing a file and changing its permissions wait for the user's approval.
