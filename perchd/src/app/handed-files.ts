/**
 * Files the agent hands the user: a reply line `[[file:<path>]]` naming a file in the chat's own
 * folder (write_file, read_document, make_zip) becomes a file in the chat, with a card and
 * Download. Only files in a chat folder (a `perch-chat-*` folder in this user's temp folder) are
 * taken, so a reply cannot pull in anything else on the Mac.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname } from "node:path";
import { FILE_TYPES } from "./artifacts";

export const FILE_MARKER = /^[ \t]*\[\[file:([^\]\n]+)\]\][ \t]*$/gm;
const MAX_BYTES = 30_000_000;

export type HandedFile = { title: string; mime: string; content: string };

/** The file at `path` when it is in a chat folder, ready to save; otherwise why not. */
export function handedFile(path: string, tempRoot = tmpdir()): HandedFile | { error: string } {
  let real: string;
  try {
    real = realpathSync(path.trim());
  } catch {
    return { error: "it doesn't exist" };
  }
  const folder = dirname(real);
  if (!basename(folder).startsWith("perch-chat-") || dirname(folder) !== realpathSync(tempRoot)) return { error: "only files in this chat's folder can be handed over" };
  const stat = statSync(real);
  if (!stat.isFile()) return { error: "it isn't a file" };
  if (stat.size > MAX_BYTES) return { error: "it is larger than 30 MB" };
  return { title: basename(real), mime: FILE_TYPES[extname(real).toLowerCase()] ?? "application/octet-stream", content: readFileSync(real).toString("base64") };
}
