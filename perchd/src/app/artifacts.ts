/**
 * Artifacts (spec 7.7): pages, documents, code, data and images a chat produces, kept per chat
 * with every version, encrypted per record like chats.
 *
 * The agent makes one by putting a fenced block in its reply:
 *
 *   ```artifact html "Subscriptions, last 12 months"
 *   <!doctype html>...
 *   ```
 *
 * `code:<language>` names the language of a code artifact. A longer fence (````) lets the content
 * hold ``` itself. Replies keep a `[[artifact:<id>]]` marker where the block was.
 */

import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDir, KeyedQueue, UUID, writePrivate } from "./files";
import type { ArtifactKind } from "./protocol";
import type { Vault } from "./vault";

export const ARTIFACT_KINDS: readonly ArtifactKind[] = ["html", "markdown", "code", "svg", "csv", "json", "image", "file"];
/** Kinds kept as base64 bytes rather than text. */
export const isBinaryKind = (kind: ArtifactKind) => kind === "image" || kind === "file";
/** A file the agent hands over (a zip, a PDF, slides): its type by extension. */
export const FILE_TYPES: Record<string, string> = {
  ".zip": "application/zip",
  ".pdf": "application/pdf",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};
const MAX_FILE_BASE64 = 40_000_000;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const MAX_TEXT = 2_000_000;
const MAX_IMAGE_BASE64 = 11_000_000;
const EXT = ".art";

export type ArtifactVersion = { content: string; mime?: string; time: string };
export type ArtifactRecord = { id: string; chatId: string; title: string; kind: ArtifactKind; language?: string; versions: ArtifactVersion[] };
export type NewArtifact = { chatId: string; title: string; kind: ArtifactKind; language?: string; content: string; mime?: string };

export class ArtifactStore {
  private records = new Map<string, ArtifactRecord>();
  private queue = new KeyedQueue();

  private constructor(
    private readonly dir: string,
    private readonly vault: Vault,
    private readonly inMemory: (chatId: string) => boolean,
  ) {}

  /** `inMemory`: chats whose artifacts are never written to disk (private chats, spec 5.8). */
  static async load(dir: string, vault: Vault, inMemory: (chatId: string) => boolean = () => false): Promise<ArtifactStore> {
    const store = new ArtifactStore(dir, vault, inMemory);
    await ensurePrivateDir(dir);
    for (const name of await readdir(dir)) {
      if (!name.endsWith(EXT)) continue;
      const id = name.slice(0, -EXT.length);
      try {
        store.records.set(id, await vault.openJson<ArtifactRecord>(id, new Uint8Array(await readFile(join(dir, name)))));
      } catch {
        // Left on disk; a damaged artifact must not stop the chats from loading.
      }
    }
    return store;
  }

  get(id: string): ArtifactRecord | undefined {
    return this.records.get(id);
  }

  /** A version's content; the newest when version is left out. Versions count from 1. */
  content(id: string, version?: number): ArtifactVersion | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    return record.versions[(version ?? record.versions.length) - 1];
  }

  forChat(chatId: string): ArtifactRecord[] {
    return [...this.records.values()].filter((r) => r.chatId === chatId);
  }

  /** Saves a new artifact, or a new version of the chat's artifact with the same title. */
  async save(input: NewArtifact): Promise<ArtifactRecord> {
    checkArtifact(input);
    const existing = this.forChat(input.chatId).find((r) => r.title === input.title.trim() && r.kind === input.kind);
    const id = existing?.id ?? crypto.randomUUID();
    return this.queue.run(id, async () => {
      const current = this.records.get(id);
      const version: ArtifactVersion = { content: input.content, ...(input.mime ? { mime: input.mime } : {}), time: new Date().toISOString() };
      const next: ArtifactRecord = current
        ? { ...current, versions: [...current.versions, version] }
        : { id, chatId: input.chatId, title: input.title.trim(), kind: input.kind, ...(input.language ? { language: input.language } : {}), versions: [version] };
      await this.write(next);
      return next;
    });
  }

  /** A copy of an artifact, every version included, owned by another chat. */
  async copy(id: string, toChatId: string): Promise<ArtifactRecord> {
    const source = this.records.get(id);
    if (!source) throw new Error(`no artifact ${id}`);
    if (!UUID.test(toChatId)) throw new Error("artifacts belong to a chat id");
    const next: ArtifactRecord = { ...source, id: crypto.randomUUID(), chatId: toChatId, versions: [...source.versions] };
    return this.queue.run(next.id, async () => {
      await this.write(next);
      return next;
    });
  }

  private async write(record: ArtifactRecord): Promise<void> {
    if (!this.inMemory(record.chatId)) await writePrivate(this.dir, `${record.id}${EXT}`, await this.vault.sealJson(record.id, record));
    this.records.set(record.id, record);
  }

  /** Gives an artifact a new name; every version keeps its content. */
  async rename(id: string, title: string): Promise<ArtifactRecord> {
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > 200) throw new Error("an artifact needs a title of up to 200 characters");
    return this.queue.run(id, async () => {
      const current = this.records.get(id);
      if (!current) throw new Error(`no artifact ${id}`);
      const next: ArtifactRecord = { ...current, title: trimmed };
      await this.write(next);
      return next;
    });
  }

  async remove(id: string): Promise<void> {
    await this.queue.run(id, async () => {
      this.records.delete(id);
      await rm(join(this.dir, `${id}${EXT}`), { force: true });
    });
  }

  async removeForChat(chatId: string): Promise<void> {
    await Promise.all(
      this.forChat(chatId).map((r) =>
        this.queue.run(r.id, async () => {
          this.records.delete(r.id);
          await rm(join(this.dir, `${r.id}${EXT}`), { force: true });
        }),
      ),
    );
  }
}

function checkArtifact(input: NewArtifact): void {
  if (!ARTIFACT_KINDS.includes(input.kind)) throw new Error(`artifact kind must be one of ${ARTIFACT_KINDS.join(", ")}`);
  if (!UUID.test(input.chatId)) throw new Error("artifacts belong to a chat id");
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200) throw new Error("an artifact needs a title of up to 200 characters");
  if (typeof input.content !== "string") throw new Error("artifact content must be text");
  if (input.kind === "file") {
    if (!input.mime || !/^[\w.+-]+\/[\w.+-]+$/.test(input.mime)) throw new Error("a file needs its type");
    if (input.content.length > MAX_FILE_BASE64) throw new Error("the file is too large (30 MB at most)");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.content)) throw new Error("files are sent as base64");
  } else if (input.kind === "image") {
    if (!IMAGE_TYPES.includes(input.mime as (typeof IMAGE_TYPES)[number])) throw new Error("images must be PNG, JPEG, WebP or GIF");
    if (input.content.length > MAX_IMAGE_BASE64) throw new Error("the image is too large (8 MB at most)");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.content)) throw new Error("images are sent as base64");
  } else if (input.content.length > MAX_TEXT) {
    throw new Error("the artifact is too large (2 MB of text at most)");
  }
  if (input.language !== undefined && !/^[\w+#.-]{1,32}$/.test(input.language)) throw new Error("the language name is not valid");
}

export type ArtifactBlock = { kind: ArtifactKind; language?: string; title: string; content: string };

const OPEN = /^(`{3,})artifact\s+([a-z]+)(?::([\w+#.-]{1,32}))?(?:\s+"([^"\n]{1,200})")?\s*$/;

/** Finds finished artifact blocks; each becomes `[[artifact:#<index>]]` in the returned text. */
export function parseArtifactBlocks(text: string): { text: string; blocks: ArtifactBlock[] } {
  const lines = text.split("\n");
  const out: string[] = [];
  const blocks: ArtifactBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i]!.match(OPEN);
    const kind = open?.[2] as ArtifactKind | undefined;
    const close = open ? lines.findIndex((l, j) => j > i && l.trim() === open[1]) : -1;
    if (!open || !kind || !ARTIFACT_KINDS.includes(kind) || isBinaryKind(kind) || close < 0) {
      out.push(lines[i]!);
      continue;
    }
    blocks.push({ kind, ...(open[3] ? { language: open[3] } : {}), title: open[4] ?? defaultTitle(kind), content: lines.slice(i + 1, close).join("\n") });
    out.push(`[[artifact:#${blocks.length - 1}]]`);
    i = close;
  }
  return { text: out.join("\n"), blocks };
}

const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const TEXT_EXT: Record<ArtifactKind, string> = { html: "html", markdown: "md", code: "txt", svg: "svg", csv: "csv", json: "json", image: "png", file: "bin" };

export function fileExtension(kind: ArtifactKind, language: string | undefined, mime: string | undefined): string {
  if (kind === "image") return IMAGE_EXT[mime ?? ""] ?? "png";
  if (kind === "code" && language && /^[\w]{1,16}$/.test(language)) return language;
  return TEXT_EXT[kind];
}

/** The name an artifact gets as a file: its title, safe for Finder, with the kind's extension. */
export function artifactFileName(record: ArtifactRecord, version: ArtifactVersion): string {
  // A handed-over file keeps its own name, extension included.
  if (record.kind === "file") return record.title.replace(/[\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "file";
  const ext = fileExtension(record.kind, record.language, version.mime);
  const stem = record.title.replace(/[\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "artifact";
  return stem.toLowerCase().endsWith(`.${ext}`) ? stem : `${stem}.${ext}`;
}

function defaultTitle(kind: ArtifactKind): string {
  return { html: "Page", markdown: "Document", code: "Code", svg: "Drawing", csv: "Table", json: "Data", image: "Image", file: "File" }[kind];
}
