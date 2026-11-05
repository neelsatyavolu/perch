/** The fixture MCP server over stdio: `bun test/fixtures/mcp-stdio-server.ts`. Prints a banner first, as some servers do. */

import { chunks } from "../../src/mcp-client/sse";
import { createFixture } from "./mcp-fixture";

const fixture = createFixture({ env: process.env });
process.stdout.write("fixture server starting\n");
process.stderr.write("fixture stderr line\n");
if (process.argv.includes("--crash")) process.exit(3);

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of chunks(Bun.stdin.stream())) {
  buffer += decoder.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    void fixture.handle(JSON.parse(line)).then((msgs) => {
      for (const m of msgs) process.stdout.write(`${JSON.stringify(m)}\n`);
    });
  }
}
