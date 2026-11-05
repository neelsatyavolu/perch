/**
 * End-to-end encryption between two paired devices over the relay. The keys come from ECDH of the
 * two devices' long-term keys (pinned at pairing) through HKDF, one per direction.
 *
 * Each side picks a random session nonce when its channel opens. Every frame carries the sender's
 * nonce, the receiver's nonce and a counter, all in the additional data. A receiver opens a message
 * only if it names the receiver's current nonce and its counter is higher than anything seen from
 * that sender session; frames from a sender session it has moved past are refused. So the relay
 * cannot replay a frame into a later session of either side (a restarted perchd included), reorder
 * into the past, reflect or redirect frames. A hello carries no payload and tells the peer this
 * side's nonce; the relay client exchanges hellos before the first message. v1 has no forward
 * secrecy (see the plan).
 */
import { concat, fromBase64Url, fromUtf8, randomBytes, sha256, toBase64Url, utf8, type Bytes } from "./encoding";
import { agreeKey, type DeviceKeys } from "./keys";

const VERSION = 2;
const NONCE = 16;
const HEADER = 1 + NONCE + NONCE + 4 + 12;
const NO_NONCE = new Uint8Array(NONCE);

export type Me = { id: string; keys: DeviceKeys };
export type Peer = { id: string; publicKey: string };

/**
 * What a frame turned out to be: a message for the app, or a hello (or a message for an earlier
 * session of this device, whose payload is dropped). `answer` means the peer does not know this
 * side's current nonce yet, so it should be sent a hello.
 */
export type Opened = { message: true; value: unknown } | { message: false; answer: boolean };

const aad = (from: string, to: string, header: Uint8Array) => concat(utf8(`perch-relay-v2|${from}|${to}|`), header);
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

export class PeerChannel {
  readonly nonce: Bytes = randomBytes(NONCE);
  private peerNonce: Bytes | null = null;
  private sent = 0;
  private session: { nonce: string; counter: number } | null = null;
  private readonly retired = new Set<string>();

  private constructor(readonly me: string, readonly peer: string, private readonly sendKey: CryptoKey, private readonly receiveKey: CryptoKey) {}

  static async open(me: Me, peer: Peer): Promise<PeerChannel> {
    if (me.id === peer.id) throw new Error("A device cannot open a channel to itself");
    const salt = await sha256(utf8([me.id, peer.id].sort().join("|")));
    const sendKey = await agreeKey(me.keys.privateKey, peer.publicKey, salt, `perch-relay-v2 ${me.id}>${peer.id}`);
    const receiveKey = await agreeKey(me.keys.privateKey, peer.publicKey, salt, `perch-relay-v2 ${peer.id}>${me.id}`);
    return new PeerChannel(me.id, peer.id, sendKey, receiveKey);
  }

  /** True once this side knows the peer's current nonce, so messages can be sealed. */
  get ready(): boolean {
    return this.peerNonce !== null;
  }

  /** A frame that tells the peer this side's nonce. */
  hello(): Promise<string> {
    return this.frame({ hello: true }, this.peerNonce ?? NO_NONCE);
  }

  /** Encrypts a JSON value for the peer, as the relay frame's `d` field. */
  seal(value: unknown): Promise<string> {
    if (!this.peerNonce) return Promise.reject(new Error("Send a hello and wait for the answer before sealing messages"));
    return this.frame({ v: value }, this.peerNonce);
  }

  private async frame(body: object, receiver: Uint8Array): Promise<string> {
    this.sent += 1;
    const head = new Uint8Array(HEADER);
    head[0] = VERSION;
    head.set(this.nonce, 1);
    head.set(receiver, 1 + NONCE);
    new DataView(head.buffer).setUint32(1 + 2 * NONCE, this.sent);
    head.set(randomBytes(12), HEADER - 12);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: head.slice(HEADER - 12), additionalData: aad(this.me, this.peer, head) }, this.sendKey, utf8(JSON.stringify(body)));
    return toBase64Url(concat(head, new Uint8Array(ct)));
  }

  /** Decrypts a frame from the peer; throws on tampering, a wrong sender or recipient, or a replay. */
  async open(d: string): Promise<Opened> {
    const bytes = fromBase64Url(d);
    if (bytes.length < HEADER + 16 || bytes[0] !== VERSION) throw new Error("Not a relay frame");
    const head = bytes.slice(0, HEADER);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: head.slice(HEADER - 12), additionalData: aad(this.peer, this.me, head) }, this.receiveKey, bytes.slice(HEADER));
    const sender = head.slice(1, 1 + NONCE);
    const toThisSession = same(head.slice(1 + NONCE, 1 + 2 * NONCE), this.nonce);
    const counter = new DataView(head.buffer).getUint32(1 + 2 * NONCE);
    this.accept(hex(sender), counter);
    this.peerNonce = sender;
    const body = JSON.parse(fromUtf8(new Uint8Array(plain))) as { hello?: true; v?: unknown };
    // A message sealed for an earlier session of this device: never delivered, only answered.
    if (body.hello || !toThisSession) return { message: false, answer: !toThisSession };
    return { message: true, value: body.v };
  }

  /** Counters only go up within a sender session, and a session once left is never taken back. */
  private accept(sender: string, counter: number): void {
    if (this.retired.has(sender)) throw new Error("Relay frame replayed or out of date");
    if (this.session?.nonce === sender) {
      if (counter <= this.session.counter) throw new Error("Relay frame replayed or out of date");
    } else if (this.session) {
      this.retired.add(this.session.nonce);
    }
    this.session = { nonce: sender, counter };
  }
}
