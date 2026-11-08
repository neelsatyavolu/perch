/**
 * The authenticator's key from Perch itself. The browser derives it from the profile's root key
 * (kept behind the Keychain) and hands it only to this extension over native messaging; the
 * extension imports it as a non-extractable CryptoKey and keeps it in memory, never on disk.
 */

import type { KeyStore } from "./vault";

export const KEYS_HOST = "co.xanom.perch.keys";
const KEY_BYTES = 32;
const NO_KEY = "Perch did not provide the authenticator key.";

export type SendNative = (host: string, message: object) => Promise<unknown>;

/**
 * get() resolves to the key or throws; it never resolves to null, because the Vault would then make
 * a key of its own that put() cannot keep. put() is a no-op: the browser owns the key.
 */
export function nativeKeyStore(send: SendNative): KeyStore {
  let pending: Promise<CryptoKey> | null = null;
  return {
    get: () => {
      pending ??= fetchKey(send).catch((error: unknown) => {
        pending = null;
        throw error;
      });
      return pending;
    },
    put: async () => {},
  };
}

async function fetchKey(send: SendNative): Promise<CryptoKey> {
  const reply = await send(KEYS_HOST, { op: "authenticator" }).catch(() => null);
  const bytes = decodeKey(reply);
  try {
    return await crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally {
    bytes.fill(0);
  }
}

function decodeKey(reply: unknown): Uint8Array {
  const text = (reply as { key?: unknown } | null)?.key;
  if (typeof text !== "string") throw new Error(NO_KEY);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    throw new Error(NO_KEY);
  }
  if (bytes.length !== KEY_BYTES) {
    bytes.fill(0);
    throw new Error(NO_KEY);
  }
  return bytes;
}
