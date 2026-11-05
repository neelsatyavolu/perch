/**
 * End-to-end encryption between two paired devices over the relay. The key comes from ECDH of the
 * two devices' long-term keys (pinned at pairing) through HKDF, separately for each direction.
 * Every frame carries the sender's epoch (when this channel was opened) and a counter; the
 * receiver refuses anything not newer than what it has seen, so the relay cannot replay, reorder
 * into the past, reflect or redirect frames. v1 has no forward secrecy (see the plan).
 */
import { concat, fromBase64Url, fromUtf8, randomBytes, sha256, toBase64Url, utf8 } from "./encoding";
import { agreeKey, type DeviceKeys } from "./keys";

const HEADER = 8 + 4 + 12;

export type Me = { id: string; keys: DeviceKeys };
export type Peer = { id: string; publicKey: string };

const aad = (from: string, to: string, header: Uint8Array) => concat(utf8(`perch-relay-v1|${from}|${to}|`), header);

function header(epoch: number, counter: number, iv: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(epoch / 2 ** 32));
  view.setUint32(4, epoch >>> 0);
  view.setUint32(8, counter);
  out.set(iv, 12);
  return out;
}

export class PeerChannel {
  private sent = 0;
  private readonly epoch: number;
  private seen = { epoch: 0, counter: 0 };

  private constructor(readonly me: string, readonly peer: string, private readonly sendKey: CryptoKey, private readonly receiveKey: CryptoKey, epoch: number) {
    this.epoch = epoch;
  }

  static async open(me: Me, peer: Peer, epoch = Date.now()): Promise<PeerChannel> {
    if (me.id === peer.id) throw new Error("A device cannot open a channel to itself");
    const salt = await sha256(utf8([me.id, peer.id].sort().join("|")));
    const sendKey = await agreeKey(me.keys.privateKey, peer.publicKey, salt, `perch-relay-v1 ${me.id}>${peer.id}`);
    const receiveKey = await agreeKey(me.keys.privateKey, peer.publicKey, salt, `perch-relay-v1 ${peer.id}>${me.id}`);
    return new PeerChannel(me.id, peer.id, sendKey, receiveKey, epoch);
  }

  /** Encrypts a JSON value for the peer, as the relay frame's `d` field. */
  async seal(value: unknown): Promise<string> {
    this.sent += 1;
    const head = header(this.epoch, this.sent, randomBytes(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: head.slice(12), additionalData: aad(this.me, this.peer, head) }, this.sendKey, utf8(JSON.stringify(value)));
    return toBase64Url(concat(head, new Uint8Array(ct)));
  }

  /** Decrypts a frame from the peer; throws on tampering, a wrong sender or recipient, or a replay. */
  async open(d: string): Promise<unknown> {
    const bytes = fromBase64Url(d);
    if (bytes.length < HEADER + 16) throw new Error("Relay frame too short");
    const head = bytes.slice(0, HEADER);
    const view = new DataView(head.buffer);
    const epoch = view.getUint32(0) * 2 ** 32 + view.getUint32(4);
    const counter = view.getUint32(8);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: head.slice(12), additionalData: aad(this.peer, this.me, head) }, this.receiveKey, bytes.slice(HEADER));
    const fresh = epoch > this.seen.epoch || (epoch === this.seen.epoch && counter > this.seen.counter);
    if (!fresh) throw new Error("Relay frame replayed or out of date");
    this.seen = { epoch, counter };
    return JSON.parse(fromUtf8(new Uint8Array(plain)));
  }
}
