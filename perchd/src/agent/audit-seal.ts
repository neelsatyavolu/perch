/**
 * Sealing for the audit log (spec 11.1, the cli-integrations deferral): each line is encrypted on
 * its own under the profile's data key, so a copy of the file off the Mac shows no sites, targets
 * or typed text. Until the browser hands perchd per-store keys (plan 3b task 3), the vault's key
 * is the one used, with the log's own additional data so a sealed chat record never opens as a line.
 */

import type { AuditEntry, AuditSealer, AuditWriter } from "./audit";
import type { Vault } from "../app/vault";

const AAD = "perch/audit/v1";

export function vaultAuditSealer(vault: Vault): AuditSealer {
  return {
    seal: async (text) => Buffer.from(await vault.seal(AAD, text)).toString("base64url"),
    open: async (sealed) => new TextDecoder().decode(await vault.open(AAD, new Uint8Array(Buffer.from(sealed, "base64url")))),
  };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * For a private (incognito) chat (spec 5.8): actions are still recorded, but without what was
 * typed or read and with the site's origin instead of the full address.
 */
export function withoutPageText(log: AuditWriter): AuditWriter {
  return {
    append: ({ detail: _detail, url, ...rest }: AuditEntry) => log.append({ ...rest, ...(url ? { url: originOf(url) } : {}) }),
  };
}
