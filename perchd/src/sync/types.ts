/** Wire shapes of Perch's sync server (server/src). Everything secret in them is ciphertext. */

export const COLLECTIONS = ["bookmarks", "history", "settings", "memory", "skills", "tabs", "chats", "artifacts"] as const;
export type Collection = (typeof COLLECTIONS)[number];

export type DeviceKind = "browser" | "cli" | "assistant";
export type DeviceInfo = { name: string; kind: DeviceKind; publicKey: string };
export type Device = DeviceInfo & { id: string; createdAt: number; lastSeenAt: number; current?: boolean };

export type SessionGrant = { sessionToken: string; accountId: string; deviceId: string };

export type ServerItem = {
  id: string;
  version: number;
  keyVersion: number;
  seq: number;
  size: number;
  deleted: boolean;
  updatedAt: number;
  ciphertext?: string;
  blob?: true;
};

export type ItemWrite =
  | { id: string; baseVersion: number; keyVersion: number; ciphertext: string }
  | { id: string; baseVersion: number; deleted: true };

export type CommitResult =
  | { id: string; status: "ok"; version: number; seq: number }
  | { id: string; status: "conflict"; current: ServerItem | null }
  | { id: string; status: "stale_key"; keyVersion: number }
  | { id: string; status: "quota" }
  | { id: string; status: "too_large" };

export type Changes = { items: ServerItem[]; next: number; more: boolean };
export type KeysInfo = { keyVersion: number; device: { version: number; blob: string } | null; recovery: { version: number; blob: string } | null };
