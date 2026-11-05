import { describe, expect, test } from "bun:test";
import { PeerChannel } from "../src/sync/channel";
import { generateDeviceKeys, type DeviceKeys } from "../src/sync/keys";
import { RelayClient, serveRemoteMcp, type SocketLike } from "../src/sync/relay-client";
import { macKeychain, memorySecretStore, type Runner } from "../src/sync/keychain";
import { approvePairing } from "../src/sync/keyring";
import type { SyncApi } from "../src/sync/api";

type Dev = { id: string; keys: DeviceKeys };
const dev = async (id: string): Promise<Dev> => ({ id, keys: await generateDeviceKeys() });
const peer = (d: Dev) => ({ id: d.id, publicKey: d.keys.publicKey });

describe("peer channel", () => {
  test("opens what the peer sealed, in both directions", async () => {
    const mac = await dev("dev_mac");
    const bot = await dev("dev_bot");
    const a = await PeerChannel.open(mac, peer(bot));
    const b = await PeerChannel.open(bot, peer(mac));
    expect(await b.open(await a.seal({ kind: "exec", body: "Find flights" }))).toEqual({ kind: "exec", body: "Find flights" });
    expect(await a.open(await b.seal({ kind: "result", body: 42 }))).toEqual({ kind: "result", body: 42 });
  });

  test("refuses replays, reflections and frames for someone else", async () => {
    const mac = await dev("dev_mac");
    const bot = await dev("dev_bot");
    const other = await dev("dev_other");
    const a = await PeerChannel.open(mac, peer(bot));
    const b = await PeerChannel.open(bot, peer(mac));
    const frame = await a.seal("hello");
    expect(await b.open(frame)).toBe("hello");
    await expect(b.open(frame)).rejects.toThrow("replayed");
    // Sent back to its sender: the direction keys differ, so it does not open.
    await expect(a.open(await a.seal("echo"))).rejects.toThrow();
    const toOther = await PeerChannel.open(mac, peer(other));
    await expect(b.open(await toOther.seal("not for bot"))).rejects.toThrow();
  });

  test("accepts a newer channel after the sender restarts, but not an older one", async () => {
    const mac = await dev("dev_mac");
    const bot = await dev("dev_bot");
    const receiver = await PeerChannel.open(bot, peer(mac));
    const old = await PeerChannel.open(mac, peer(bot), 1000);
    const restarted = await PeerChannel.open(mac, peer(bot), 2000);
    const stale = await old.seal("old");
    expect(await receiver.open(await restarted.seal("new"))).toBe("new");
    await expect(receiver.open(stale)).rejects.toThrow("out of date");
  });
});

/** A relay room in memory: routes frames by recipient, like server/src/relay.ts. */
function fakeRelay() {
  const sockets = new Map<string, { deliver: (data: string) => void }>();
  const connect = (deviceId: string) => (): SocketLike => {
    const listeners: Record<string, ((event: any) => void)[]> = {};
    const socket: SocketLike = {
      send(data) {
        const frame = JSON.parse(data);
        sockets.get(frame.to)?.deliver(JSON.stringify({ t: "msg", from: deviceId, d: frame.d }));
      },
      close() {},
      addEventListener(type, listener) {
        (listeners[type] ??= []).push(listener);
      },
    };
    sockets.set(deviceId, { deliver: (data) => listeners.message?.forEach((l) => l({ data })) });
    queueMicrotask(() => listeners.open?.forEach((l) => l({})));
    return socket;
  };
  return { connect, inject: (to: string, from: string, d: string) => sockets.get(to)?.deliver(JSON.stringify({ t: "msg", from, d })) };
}

describe("relay client", () => {
  test("carries remote MCP between paired devices and answers with the sender's id", async () => {
    const relay = fakeRelay();
    const mac = await dev("dev_mac");
    const bot = await dev("dev_bot");
    const macClient = new RelayClient({ token: "t", me: mac, trusted: [peer(bot)], connect: relay.connect(mac.id) });
    const botClient = new RelayClient({ token: "t", me: bot, trusted: [peer(mac)], connect: relay.connect(bot.id) });
    await Promise.all([macClient.connect(), botClient.connect()]);
    const seenFrom: string[] = [];
    serveRemoteMcp(macClient, async (from, body: any) => {
      seenFrom.push(from);
      return { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "snapshot" }] } };
    });
    const reply = new Promise((resolve) => botClient.on("message", (_from, message) => resolve(message)));
    await botClient.send(mac.id, { kind: "mcp", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(await reply).toEqual({ kind: "mcp", body: { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "snapshot" }] } } });
    expect(seenFrom).toEqual([bot.id]);
  });

  test("drops messages from devices it has not paired with", async () => {
    const relay = fakeRelay();
    const mac = await dev("dev_mac");
    const intruder = await dev("dev_intruder");
    const macClient = new RelayClient({ token: "t", me: mac, trusted: [], connect: relay.connect(mac.id) });
    await macClient.connect();
    const got: unknown[] = [];
    macClient.on("message", (_f, m) => got.push(m));
    const channel = await PeerChannel.open(intruder, peer(mac));
    relay.inject(mac.id, intruder.id, await channel.seal({ kind: "exec", body: "rm -rf" }));
    await Bun.sleep(10);
    expect(got).toEqual([]);
    await expect(macClient.send(intruder.id, { kind: "x", body: 1 })).rejects.toThrow("not paired");
  });
});

describe("keychain", () => {
  test("writes secrets on stdin, never in arguments", async () => {
    const calls: { args: string[]; stdin?: string }[] = [];
    const run: Runner = async (args, stdin) => {
      calls.push({ args, stdin });
      return { code: 0, stdout: Buffer.from("secret value", "utf8").toString("base64url") + "\n" };
    };
    const store = macKeychain(run);
    await store.set("session-token", "pst_fake 'quoted' value");
    expect(calls[0]!.args).toEqual(["-i"]);
    expect(calls[0]!.args.join(" ")).not.toContain("pst_fake");
    expect(calls[0]!.stdin).toContain("add-generic-password -U -s co.xanom.perch.sync -a session-token -w ");
    expect(calls[0]!.stdin).not.toContain("'");
    expect(await store.get("session-token")).toBe("secret value");
    await expect(store.get("../bad")).rejects.toThrow("name");
  });

  test("reports a missing item as null", async () => {
    const store = macKeychain(async () => ({ code: 44, stdout: "" }));
    expect(await store.get("device-keys")).toBeNull();
  });

  test("memory store for tests and incognito", async () => {
    const store = memorySecretStore();
    await store.set("a", "1");
    expect(await store.get("a")).toBe("1");
    await store.delete("a");
    expect(await store.get("a")).toBeNull();
  });
});

describe("pairing approval", () => {
  test("refuses when the server's key does not match the typed code", async () => {
    const real = await dev("new");
    const swapped = await dev("attacker");
    const mac = await dev("dev_mac");
    const { newPairingCode } = await import("../src/sync/pairing");
    let approved = false;
    const api = { approvePairing: async () => ((approved = true), { deviceId: "dev_x" }) } as unknown as SyncApi;
    const code = await newPairingCode(real.keys.publicKey);
    const lookup = { pairingId: "pair_x", code: code.lookup, publicKey: swapped.keys.publicKey, name: "Grok", kind: "cli", expiresAt: 0 };
    await expect(approvePairing(api, lookup, code.display, { device: mac })).rejects.toThrow("does not match");
    expect(approved).toBe(false);
  });
});
