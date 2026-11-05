/**
 * Asking the person at the Mac, not the program on the socket. Letting a client do more without
 * asking, or letting a revoked client back in, needs a click in a macOS dialog that perchd shows:
 * an agent with a shell can run `perch`, but it cannot answer this.
 */

export type Confirm = (message: string) => Promise<boolean>;

export type Runner = (args: string[], stdin: string) => Promise<{ code: number; stdout: string }>;

const ALLOW = "Allow";
const DENY = "Don't Allow";
const WAIT_SECONDS = 60;

/** An AppleScript string literal. */
function appleString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`;
}

export function dialogScript(message: string): string {
  return `display dialog ${appleString(message)} with title "Perch" buttons {${appleString(DENY)}, ${appleString(ALLOW)}} default button ${appleString(DENY)} cancel button ${appleString(DENY)} with icon caution giving up after ${WAIT_SECONDS}\n`;
}

const runOsascript: Runner = async (args, stdin) => {
  const child = Bun.spawn(["/usr/bin/osascript", ...args], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const sink = child.stdin as import("bun").FileSink;
  sink.write(stdin);
  await sink.end();
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, stdout };
};

/** A dialog with Don't Allow as the default; a timeout, an error or no screen means no. */
export function macConfirm(run: Runner = runOsascript): Confirm {
  return async (message) => {
    try {
      const r = await run(["-"], dialogScript(message));
      return r.code === 0 && r.stdout.includes(`button returned:${ALLOW}`) && !r.stdout.includes("gave up:true");
    } catch {
      return false;
    }
  };
}
