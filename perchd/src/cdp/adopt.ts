/**
 * CDP over descriptors perchd inherited from the browser that started it (spec 7.1). Perch hands
 * perchd one end of two socket pairs: perchd reads the browser's messages on fd 3 and writes its
 * own on fd 4. The framing is --remote-debugging-pipe's: NUL-terminated JSON.
 */

import { createReadStream, createWriteStream } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { CdpConnection } from "./connection";
import { encode, FrameDecoder } from "./pipe";

/** A connection over an already-open pair of streams: what perchd writes, and what it reads. */
export function connectStreams(toBrowser: Writable, fromBrowser: Readable): CdpConnection {
  const conn = new CdpConnection(
    (message) => {
      if (toBrowser.destroyed || !toBrowser.writable) throw new Error("browser closed");
      toBrowser.write(encode(message));
    },
    async () => {
      // The browser owns its own life; perchd only lets go of its end.
      toBrowser.end();
    },
  );
  const onError = (error: Error) => conn.fail(new Error(`browser closed (${error.message})`));
  toBrowser.on("error", onError);
  fromBrowser.on("error", onError);
  const decoder = new FrameDecoder();
  fromBrowser.on("data", (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) conn.handle(message);
  });
  fromBrowser.on("end", () => conn.fail(new Error("browser closed")));
  fromBrowser.on("close", () => conn.fail(new Error("browser closed")));
  return conn;
}

/** CDP to the browser that started perchd: read on fd 3, written on fd 4. */
export function adoptBrowserFds(readFd = 3, writeFd = 4): CdpConnection {
  return connectStreams(createWriteStream("", { fd: writeFd }), createReadStream("", { fd: readFd }));
}
