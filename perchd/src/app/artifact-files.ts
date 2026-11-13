/**
 * Artifacts as real files: Download writes one to the user's Downloads folder, and Show in Finder
 * reveals it there. A version is written once per run of perchd; asking again reuses that file
 * while it still exists, so Download followed by Show in Finder does not make a copy.
 */

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { downloadsDir, freePath } from "../agent/tools";
import { artifactFileName, isBinaryKind, type ArtifactRecord, type ArtifactVersion } from "./artifacts";

const saved = new Map<string, string>();

export type SaveOptions = {
  reveal?: boolean;
  /** Where files go; the Downloads folder by default. */
  dir?: string;
  /** Shows a file in Finder; `open -R` by default. */
  revealFile?: (path: string) => Promise<void>;
};

export async function saveArtifactFile(record: ArtifactRecord, version: number, content: ArtifactVersion, opts: SaveOptions = {}): Promise<string> {
  const key = `${record.id}:${version}:${record.title}`;
  let path = saved.get(key);
  if (!path || !existsSync(path)) {
    path = freePath(opts.dir ?? downloadsDir(), artifactFileName(record, content));
    await writeFile(path, isBinaryKind(record.kind) ? Buffer.from(content.content, "base64") : content.content, { flag: "wx" });
    saved.set(key, path);
  }
  if (opts.reveal) await (opts.revealFile ?? revealInFinder)(path);
  return path;
}

async function revealInFinder(path: string): Promise<void> {
  const child = Bun.spawn(["/usr/bin/open", "-R", path], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  if ((await child.exited) !== 0) throw new Error("Finder could not show the file");
}
