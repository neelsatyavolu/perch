/** Launches a browser, prints its pid, and waits to be killed. Used by the orphan test. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchChromium, findChromeForTesting } from "../../src/cdp/pipe";

const conn = await launchChromium({ executable: process.env.ORPHAN_EXE || (await findChromeForTesting()), userDataDir: mkdtempSync(join(tmpdir(), "orphan-")), headless: process.env.ORPHAN_WINDOW !== "1", args: ["--mock-keychain"] });
console.log(`pid ${conn.pid}`);
await new Promise(() => {});
