/**
 * Development entry for the app API: Perch's chat pages against a headless test browser, before
 * the Perch build hosts them (docs/design/webui-hosting.md).
 *
 *   bun run src/app/main.ts [--data <dir>] [--mock-keychain] [--show]
 *
 * It serves ui/dist at /ui/ and prints the page address with this launch's token in the URL
 * fragment, which never reaches a server or a log. Chats are encrypted with the key in the
 * Keychain item "Perch Data Key"; --mock-keychain keeps the key in memory for a throwaway run.
 * Models: a scripted one that only answers, and Claude through ANTHROPIC_API_KEY when it is set.
 */

import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../agent/audit";
import { Browser } from "../browser/browser";
import { anthropicModel } from "../models/anthropic";
import { fakeModel } from "../models/fake";
import type { Model } from "../models/types";
import { startApp } from "./app";
import { macKeychain, memoryKeychain } from "./keychain";
import type { ModelInfo } from "./protocol";
import { loopRunner } from "./runner";
import { Vault } from "./vault";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const MODELS: ModelInfo[] = [
  { id: "scripted", label: "Scripted (no model)", provider: "Perch", efforts: ["medium"] },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", provider: "Anthropic API key", efforts: ["low", "medium", "high"] },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", provider: "Anthropic API key", efforts: ["low", "medium", "high"] },
];

async function model(id: string): Promise<Model | string> {
  if (id === "scripted") return fakeModel(() => [{ type: "text", delta: "This is the scripted model. Pick a signed-in model to run tasks." }, { type: "done" }]);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return "Claude needs an API key. Set ANTHROPIC_API_KEY for this development run, or pick another model";
  return anthropicModel({ model: id, apiKey: async () => key });
}

async function main(argv: string[]): Promise<void> {
  const dataDir = arg(argv, "--data") ?? join(homedir(), "Library", "Application Support", "Perch", "Default", "app");
  const keychain = argv.includes("--mock-keychain") ? memoryKeychain() : macKeychain();
  let browser: Promise<Browser> | null = null;
  const app = await startApp({
    dataDir,
    vault: await Vault.open(keychain, "Default"),
    runner: loopRunner({
      browser: () => (browser ??= Browser.launch({ userDataDir: mkdtempSync(join(tmpdir(), "perch-app-")), headless: !argv.includes("--show") })),
      model,
      audit: new AuditLog(join(dataDir, "..", "audit.jsonl")),
    }),
    models: MODELS,
    allowedOrigins: [],
    uiDir: join(import.meta.dir, "..", "..", "..", "ui", "dist"),
  });
  process.stdout.write(`Perch chat: ${app.server.url}/ui/chat.html#token=${app.token}\nSidebar:    ${app.server.url}/ui/sidebar.html#token=${app.token}&window=dev&tab=dev-tab\n`);
  const stop = async () => {
    await app.stop();
    if (browser) await (await browser).close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

if (import.meta.main) await main(process.argv.slice(2));
