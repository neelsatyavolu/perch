---
name: gmail
description: Read, search, draft and send mail in Gmail (mail.google.com) in the user's signed-in account. Use for any task about the user's Gmail inbox, threads, labels or attachments.
---

# Gmail

The user is signed in at mail.google.com. Work in that account; never sign in or out.

## Find mail

Open a search directly instead of typing into the search box:

`https://mail.google.com/mail/u/0/#search/<query>` (URL-encode the query)

Search operators that work in the query:

- `from:anna@example.com`, `to:me`, `cc:`, `subject:(quarterly report)`
- `has:attachment`, `filename:pdf`, `larger:5M`
- `is:unread`, `is:starred`, `is:important`, `in:inbox`, `in:sent`, `in:anywhere`, `label:<name>`
- `after:2026/10/01`, `before:2026/11/01`, `newer_than:7d`, `older_than:1y`
- `"exact phrase"`, `OR`, `-word` to exclude

`/u/0/` is the first signed-in account. If the page shows a different address than the task names, try `/u/1/`, `/u/2/`.

## Read a thread

Click the row in the results, then take a snapshot. Long threads collapse older messages; click the collapsed count ("3 older messages") to expand them before reading. Quoted text hides behind a "Show trimmed content" button.

## Write mail

Open a prefilled compose window:

`https://mail.google.com/mail/u/0/?view=cm&fs=1&to=<addr>&cc=<addr>&su=<subject>&body=<body>`

URL-encode every value; use `%0A` for new lines in the body. Check the To, Subject and body fields in the snapshot before sending. Sending waits for the user's approval in Guard and Ask modes.

To reply, open the thread and click "Reply" (or "Reply all" when the task says everyone), type into the message body, then click "Send".

## Tidy up

Archive, delete, label and mark-as-read buttons appear in the toolbar above an open thread, or on hover over a row in a list. Select several rows with their checkboxes first for bulk changes.

## Notes

- Keyboard shortcuts may be off in the user's settings; prefer clicking buttons.
- Attachments: the attachment chips at the bottom of a message have download buttons. Use `upload` on the paperclip input when attaching a file.
- Never forward or send mail the task did not ask for.
