/**
 * HTTP client for the sync server. Holds the session token in memory only; the caller loads it
 * from and saves it to the Keychain. Errors carry the server's plain message for the UI.
 */
import type { Changes, Collection, CommitResult, Device, DeviceInfo, ItemWrite, KeysInfo, SessionGrant } from "./types";

export const DEFAULT_API = "https://api.perchbrowser.com";

export class SyncApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfter?: number) {
    super(message);
  }
}

export type FetchLike = (input: string | Request, init?: RequestInit) => Promise<Response>;
type Options = { baseUrl?: string; fetch?: FetchLike; token?: string };

export type EmailStart = { requestId: string; pollSecret: string; matchNumber: number; expiresAt: number };
export type SignInPoll = ({ status: "signed_in"; newAccount?: boolean } & SessionGrant) | { status: "pending" };
export type PairingStart = { pairingId: string; code: string; pollSecret: string; expiresAt: number };
export type PairingLookup = { pairingId: string; code: string; publicKey: string; name: string; kind: string; expiresAt: number };
export type PairingPoll = { status: "pending" } | ({ status: "approved"; approverDeviceId: string; grant: string; peers: Device[] } & SessionGrant);

export class SyncApi {
  readonly baseUrl: string;
  private readonly fetcher: FetchLike;
  private token: string | undefined;

  constructor(options: Options = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_API).replace(/\/$/, "");
    if (!/^https:\/\//.test(this.baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(this.baseUrl)) {
      throw new Error("The sync server must use https");
    }
    this.fetcher = options.fetch ?? fetch;
    this.token = options.token;
  }

  withToken(token: string): SyncApi {
    return new SyncApi({ baseUrl: this.baseUrl, fetch: this.fetcher, token });
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await this.fetcher(`${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.ok && response.headers.get("content-type")?.includes("application/octet-stream")) {
      return new Uint8Array(await response.arrayBuffer()) as T;
    }
    const data = (await response.json().catch(() => ({}))) as { error?: { code: string; message: string } };
    if (!response.ok) {
      const retry = Number(response.headers.get("retry-after") ?? "") || undefined;
      throw new SyncApiError(response.status, data.error?.code ?? "http_error", data.error?.message ?? `The sync server answered ${response.status}.`, retry);
    }
    return data as T;
  }

  // Account
  startEmail = (email: string, device: DeviceInfo) => this.request<EmailStart>("POST", "/v1/auth/email/start", { email, device });
  verifyEmailCode = (start: EmailStart, code: string) =>
    this.request<SignInPoll>("POST", "/v1/auth/email/verify", { requestId: start.requestId, pollSecret: start.pollSecret, code });
  pollEmail = (start: EmailStart) => this.request<SignInPoll>("POST", "/v1/auth/email/poll", { requestId: start.requestId, pollSecret: start.pollSecret });
  account = () => this.request<{ id: string; email: string; bytesUsed: number; quotaBytes: number; keyVersion: number; deviceId: string }>("GET", "/v1/account");
  deleteAccount = () => this.request<{ ok: true }>("DELETE", "/v1/account", { confirm: "delete my account" });

  // Devices
  devices = async () => (await this.request<{ devices: Device[] }>("GET", "/v1/devices")).devices;
  renameDevice = (id: string, name: string) => this.request<{ ok: true }>("PATCH", `/v1/devices/${encodeURIComponent(id)}`, { name });
  revokeDevice = (id: string) => this.request<{ ok: true }>("DELETE", `/v1/devices/${encodeURIComponent(id)}`);

  // Keys
  keys = () => this.request<KeysInfo>("GET", "/v1/keys");
  rotateKey = (version: number, devices: Record<string, string>, recovery?: string) =>
    this.request<{ ok: true; keyVersion: number; skipped: string[] }>("POST", "/v1/keys/rotate", { version, devices, ...(recovery ? { recovery } : {}) });
  grantKey = (deviceId: string, version: number, blob: string) =>
    this.request<{ ok: true }>("PUT", `/v1/keys/devices/${encodeURIComponent(deviceId)}`, { version, blob });
  setRecovery = (version: number, blob: string) => this.request<{ ok: true }>("PUT", "/v1/keys/recovery", { version, blob });

  // Sync
  commit = async (collection: Collection, items: ItemWrite[]) =>
    (await this.request<{ results: CommitResult[] }>("POST", `/v1/sync/${collection}/commit`, { items })).results;
  changes = (collection: Collection, after: number, limit = 500) => this.request<Changes>("GET", `/v1/sync/${collection}/changes?after=${after}&limit=${limit}`);
  blob = (collection: Collection, id: string) => this.request<Uint8Array<ArrayBuffer>>("GET", `/v1/sync/${collection}/items/${encodeURIComponent(id)}/blob`);
  usage = () => this.request<{ bytesUsed: number; quotaBytes: number; keyVersion: number }>("GET", "/v1/sync/usage");

  // Pairing
  /** `code` is the commitment half of the pairing code (pairing.ts); the secret half never leaves the device. */
  startPairing = (device: DeviceInfo, code: string) => this.request<PairingStart>("POST", "/v1/pair/start", { ...device, code });
  lookupPairing = (code: string) => this.request<PairingLookup>("GET", `/v1/pair/lookup?code=${encodeURIComponent(code)}`);
  approvePairing = (pairingId: string, grant: string) => this.request<{ deviceId: string }>("POST", `/v1/pair/${encodeURIComponent(pairingId)}/approve`, { grant });
  denyPairing = (pairingId: string) => this.request<{ ok: true }>("POST", `/v1/pair/${encodeURIComponent(pairingId)}/deny`, {});
  pollPairing = (start: PairingStart) => this.request<PairingPoll>("POST", "/v1/pair/poll", { pairingId: start.pairingId, pollSecret: start.pollSecret });
}
