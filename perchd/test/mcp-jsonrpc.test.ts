import { expect, test } from "bun:test";
import { RpcSession, type JsonRpcMessage, type Transport } from "../src/mcp-client/jsonrpc";

/** A server that answers every request with its own method name. */
function echoServer(): Transport {
  let deliver: (msg: JsonRpcMessage) => void = () => undefined;
  return {
    async start(onMessage) {
      deliver = onMessage;
    },
    async send(msg) {
      if (msg.id !== undefined && msg.method) queueMicrotask(() => deliver({ jsonrpc: "2.0", id: msg.id, result: msg.method }));
    },
    async close() {},
  };
}

test("answered requests stop listening to the chat's signal, so a long chat does not pile up listeners", async () => {
  const session = new RpcSession(echoServer());
  await session.start();
  const signal = new AbortController().signal;
  let listening = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<typeof add>) => (listening++, add(...args))) as typeof add;
  signal.removeEventListener = ((...args: Parameters<typeof remove>) => (listening--, remove(...args))) as typeof remove;
  for (let i = 0; i < 20; i++) expect(await session.request<string>("tools/call", {}, { signal })).toBe("tools/call");
  expect(listening).toBe(0);
});

test("a request cancelled by its signal fails at once", async () => {
  const silent: Transport = { async start() {}, async send() {}, async close() {} };
  const session = new RpcSession(silent);
  await session.start();
  const stop = new AbortController();
  const pending = session.request("tools/call", {}, { signal: stop.signal });
  stop.abort();
  await expect(pending).rejects.toThrow("Cancelled.");
});
