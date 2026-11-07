/**
 * Settings → Permissions → Activity log over the profile's one audit log (spec 7.4): pages of
 * entries, newest first, and an export the page saves as a file. perchd has no save dialog, so the
 * export comes back as text and the page offers it as a download.
 */

import { createHash } from "node:crypto";
import type { AuditEntry, AuditExport, AuditOutcome } from "../../../../ui-pages/src/api";
import type { AuditEntry as LogEntry } from "../../agent/audit";
import { SIDEBAR_CLIENT } from "../../daemon/server";
import { AppError } from "../runs";
import * as v from "../validate";
import { capitalize, type Methods } from "./common";
import type { PagesDeps } from "./deps";

const MAX_AUDIT = 500;
const FORMATS = ["jsonl", "csv"] as const;
const TYPES = { jsonl: "application/x-ndjson", csv: "text/csv" } as const;

function outcome(e: LogEntry): AuditOutcome {
  if (e.result === "blocked") return "blocked";
  if (e.result === "declined" || e.approved === false) return "declined";
  return e.approved === true ? "approved" : "ran";
}

function clientLabel(client: string): string {
  if (client === SIDEBAR_CLIENT || client === "sidebar") return "Perch";
  if (client.startsWith("routine:")) return "Perch routine";
  return client;
}

export function toPageEntry(e: LogEntry): AuditEntry {
  const words = capitalize(e.action.replace(/_/g, " "));
  const action = e.detail ? `${words}: ${String(e.detail).slice(0, 200)}` : words;
  return {
    id: createHash("sha256").update(JSON.stringify(e)).digest("hex").slice(0, 24),
    at: e.time, client: clientLabel(String(e.client ?? "")), tab: String(e.tab ?? ""), site: String(e.site ?? ""), action, outcome: outcome(e),
  };
}

export function auditPages(deps: PagesDeps): Methods<"listAuditLog" | "exportAuditLog"> {
  const now = () => (deps.now ?? (() => new Date()))();
  return {
    async listAuditLog([query]) {
      const o = v.object(query, '"query"');
      v.onlyKeys(o, ["limit", "before"]);
      const limit = v.integer(o.limit, "limit", 0, MAX_AUDIT);
      const before = v.optionalText(o.before, "before", 40);
      if (before !== undefined && Number.isNaN(Date.parse(before))) throw new AppError('"before" must be a date and time');
      return (await deps.audit.read({ limit, ...(before ? { before } : {}) })).map(toPageEntry);
    },
    async exportAuditLog([format]): Promise<AuditExport> {
      const f = format === undefined ? "jsonl" : v.oneOf(format, "format", FORMATS);
      const { text, entries } = await deps.audit.export(f);
      const day = now().toISOString().slice(0, 10);
      return { name: `perch-activity-${day}.${f}`, type: TYPES[f], entries, text };
    },
  };
}
