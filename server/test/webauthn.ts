/**
 * A software passkey for tests: an ES256 key, "none" attestation, and assertions signed with
 * WebCrypto. Just enough CBOR to encode the attestation object and the COSE key.
 */
import { sha256, toBase64Url } from "../src/crypto";

type Cbor = number | string | Uint8Array | CborMap | CborObject;
interface CborMap extends Map<Cbor, Cbor> {}
interface CborObject {
  [key: string]: Cbor;
}

function head(major: number, value: number): number[] {
  if (value < 24) return [(major << 5) | value];
  if (value < 256) return [(major << 5) | 24, value];
  if (value < 65536) return [(major << 5) | 25, value >> 8, value & 255];
  return [(major << 5) | 26, (value >>> 24) & 255, (value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function cbor(value: Cbor): Uint8Array {
  if (typeof value === "number") return new Uint8Array(value >= 0 ? head(0, value) : head(1, -1 - value));
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return concat(new Uint8Array(head(3, bytes.length)), bytes);
  }
  if (value instanceof Uint8Array) return concat(new Uint8Array(head(2, value.length)), value);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return concat(new Uint8Array(head(5, entries.length)), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)]));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);

/** Raw r||s to the DER form WebAuthn signatures use. */
function der(raw: Uint8Array): Uint8Array {
  const int = (bytes: Uint8Array) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    const trimmed = bytes.slice(i);
    const body = trimmed[0]! & 0x80 ? concat(new Uint8Array([0]), trimmed) : trimmed;
    return concat(new Uint8Array([2, body.length]), body);
  };
  const seq = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, seq.length]), seq);
}

export class SoftPasskey {
  private counter = 0;
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16));

  private constructor(private readonly keys: CryptoKeyPair, readonly rpId: string, readonly origin: string) {}

  static async create(rpId = "perchbrowser.com", origin = "https://perchbrowser.com"): Promise<SoftPasskey> {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    return new SoftPasskey(keys, rpId, origin);
  }

  get id(): string {
    return toBase64Url(this.credentialId);
  }

  private async authData(flags: number, attested?: Uint8Array): Promise<Uint8Array> {
    this.counter += 1;
    return concat(await sha256(this.rpId), new Uint8Array([flags]), u32(this.counter), attested ?? new Uint8Array());
  }

  private clientData(type: string, challenge: string, origin: string): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  async register(challenge: string, origin = this.origin) {
    const jwk = (await crypto.subtle.exportKey("jwk", this.keys.publicKey)) as JsonWebKey;
    const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, base64urlBytes(jwk.x!)], [-3, base64urlBytes(jwk.y!)]]));
    const attested = concat(new Uint8Array(16), new Uint8Array([0, this.credentialId.length]), this.credentialId, cose);
    const authData = await this.authData(0x01 | 0x04 | 0x40, attested);
    const attestationObject = cbor({ fmt: "none", attStmt: {}, authData });
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: toBase64Url(this.clientData("webauthn.create", challenge, origin)),
        attestationObject: toBase64Url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  async authenticate(challenge: string, userHandle: string, origin = this.origin) {
    const authData = await this.authData(0x01 | 0x04);
    const clientData = this.clientData("webauthn.get", challenge, origin);
    const signed = concat(authData, await sha256(clientData));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: toBase64Url(clientData),
        authenticatorData: toBase64Url(authData),
        signature: toBase64Url(der(raw)),
        userHandle,
      },
      clientExtensionResults: {},
    };
  }
}

function base64urlBytes(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
