/**
 * Sealing for the audit log (spec 11.1, the cli-integrations deferral): each line is encrypted on
 * its own under the profile's data key, so a copy of the file off the Mac shows no sites, targets
 * or typed text. Until the browser hands perchd per-store keys (plan 3b task 3), the vault's key
 * is the one used, with the log's own additional data so a sealed chat record never opens as a line.
 */

import type { AuditSealer, AuditWriter } from "./audit";
import type { Vault } from "../app/vault";

const AAD = "perch/audit/v1";

export function vaultAuditSealer(vault: Vault): AuditSealer {
  return {
    seal: async (text) => Buffer.from(await vault.seal(AAD, text)).toString("base64url"),
    open: async (sealed) => new TextDecoder().decode(await vault.open(AAD, new Uint8Array(Buffer.from(sealed, "base64url")))),
  };
}

/**
 * For a private (incognito) chat (spec 5.8): nothing it does is written to the audit log, so the
 * log shows no trace of the sites it visited.
 */
export const PRIVATE_AUDIT: AuditWriter = { append: async () => {} };
