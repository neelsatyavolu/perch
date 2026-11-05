/**
 * Aside's agent data in ~/.aside/u/<n>: memory (markdown under memory/), the user's own skills
 * (skills/user/), and chats (state.db: sessions and their turns). Model logins in
 * credentials.json are never read; the user signs in to Perch again.
 */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { columns, hasTable, withSqliteCopy } from "./sqlite-copy";
import type { Chat, ChatTurn, TextFile } from "./types";

const MAX_FILE = 1024 * 1024;
const MAX_FILES = 5000;
const SKILL_TEXT = /\.(md|txt|json|ya?ml|js|mjs|ts|py|sh|html|css|csv)$/i;
const NEVER = new Set(["credentials.json", "accounts.json", ".env"]);

function textFiles(root: string, accept: (name: string) => boolean): TextFile[] {
  const out: TextFile[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 12 || out.length >= MAX_FILES) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith(".") || NEVER.has(name)) continue;
      const path = join(dir, name);
      const st = lstatSync(path); // symlinks are not followed out of Aside's folder
      if (st.isDirectory()) walk(path, depth + 1);
      else if (st.isFile() && st.size <= MAX_FILE && accept(name) && out.length < MAX_FILES) out.push({ path: relative(root, path), text: readFileSync(path, "utf8") });
    }
  };
  walk(root, 0);
  return out;
}

export function readAsideMemory(account: string): TextFile[] {
  return textFiles(join(account, "memory"), (n) => n.endsWith(".md"));
}

export function readAsideSkills(account: string): TextFile[] {
  return textFiles(join(account, "skills", "user"), (n) => SKILL_TEXT.test(n));
}

const toMs = (t: number | null | undefined) => (!t ? 0 : t > 1e12 ? t : t * 1000);

type SessionRow = { id: string; title: string; created_at: number };
type TurnRow = { session_id: string; user_message: string; final_assistant_message: string | null; started_at: number };

export function readAsideChats(account: string): Promise<Chat[]> {
  return withSqliteCopy(join(account, "state.db"), (db) => {
    if (!hasTable(db, "sessions") || !hasTable(db, "session_turns")) return [];
    const cols = columns(db, "sessions");
    const hide = [cols.has("incognito") && "incognito = 0", cols.has("ephemeral") && "ephemeral = 0", cols.has("archived_at") && "archived_at IS NULL"].filter(Boolean).join(" AND ");
    const sessions = db.query(`SELECT id, title, created_at FROM sessions${hide ? ` WHERE ${hide}` : ""} ORDER BY created_at`).all() as SessionRow[];
    const turns = db.query("SELECT session_id, user_message, final_assistant_message, started_at FROM session_turns ORDER BY id").all() as TurnRow[];
    const bySession = new Map<string, ChatTurn[]>();
    for (const t of turns) {
      const list = bySession.get(t.session_id) ?? [];
      list.push({ user: t.user_message, assistant: t.final_assistant_message ?? "", at: toMs(t.started_at) });
      bySession.set(t.session_id, list);
    }
    return sessions.flatMap((s) => {
      const chatTurns = bySession.get(s.id) ?? [];
      return chatTurns.length ? [{ id: s.id, title: s.title, created: toMs(s.created_at), turns: chatTurns }] : [];
    });
  });
}

export async function countAsideChats(account: string): Promise<number> {
  return (await readAsideChats(account)).length;
}
