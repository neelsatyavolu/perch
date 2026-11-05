/**
 * The socket's framing: one JSON object per line. Writes are queued until the socket drains,
 * so a large screenshot is never cut off, and an overlong line is refused rather than buffered.
 */

/** Large enough for a full-page screenshot, small enough that a bad client cannot fill memory. */
export const MAX_LINE = 32 * 1024 * 1024;

export class LineTooLongError extends Error {
  constructor() {
    super("message too long");
  }
}

export class LineReader {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) lines.push(line);
    }
    if (this.buffer.length > MAX_LINE) throw new LineTooLongError();
    return lines;
  }
}

type Writable = { write(data: Uint8Array): number; end(): void };

export class SocketWriter {
  private pending: Uint8Array[] = [];
  private ended = false;

  constructor(private readonly socket: Writable) {}

  send(message: object): void {
    if (this.ended) return;
    this.pending.push(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
    this.flush();
  }

  /** Call from the socket's drain handler. */
  flush(): void {
    while (this.pending.length) {
      const head = this.pending[0]!;
      const written = this.socket.write(head);
      if (written < 0) return;
      if (written < head.length) {
        this.pending[0] = head.subarray(written);
        return;
      }
      this.pending.shift();
    }
    if (this.ended) this.socket.end();
  }

  /** Ends the socket once everything queued has been written. */
  end(): void {
    this.ended = true;
    if (!this.pending.length) this.socket.end();
  }
}
