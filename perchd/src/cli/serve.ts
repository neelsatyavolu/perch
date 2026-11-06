/** `perch serve`: runs perchd in the foreground until it is stopped. */

import { mkdirSync } from "node:fs";
import { Browser } from "../browser/browser";
import { browserExecutable, startDaemon } from "../daemon/daemon";
import { MacKeychain } from "../daemon/keychain";
import { parseArgs } from "./args";
import { pathsFor, type CliIO } from "./io";

export async function serve(argv: string[], io: CliIO): Promise<number> {
  // Perch started this perchd and handed it CDP and its settings (src/cli/serve-browser.ts).
  if (argv.includes("--browser-fds")) {
    const { serveInBrowser } = await import("./serve-browser");
    return serveInBrowser(io);
  }
  const a = parseArgs(argv, { flags: ["--headless"], options: ["--browser"] });
  const paths = pathsFor(io);
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const executable = browserExecutable(a.options.get("--browser") ?? io.env.PERCH_BROWSER);
  const daemon = await startDaemon({
    paths,
    keychain: io.keychain ?? new MacKeychain(),
    sealKeychain: io.keychain ? undefined : new MacKeychain("Perch registry"),
    launch: () => Browser.launch({ userDataDir: paths.profileDir, executable, headless: a.flags.has("--headless") }),
  });
  io.stderr(`perchd ${process.pid} listening on ${paths.socket}\n`);
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
  await daemon.stop();
  return 0;
}
