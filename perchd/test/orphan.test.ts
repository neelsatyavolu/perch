import { expect, test } from "bun:test";
import { join } from "node:path";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

for (const [windowed, hung] of [[false, false], [true, false], [false, true]]) test(`the browser is closed when the process that launched it is killed (${windowed ? "with a window" : "headless"}${hung ? ", browser not responding" : ""})`, async () => {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "fixtures/launch-and-hang.ts")], { stdout: "pipe", stderr: "inherit", env: { ...process.env, ORPHAN_WINDOW: windowed ? "1" : "0" } });
  const reader = proc.stdout.getReader();
  let out = "";
  while (!/pid \d+/.test(out)) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  const pid = Number(out.match(/pid (\d+)/)?.[1]);
  expect(alive(pid)).toBe(true);
  // A browser that is not responding never reads the end of its pipe.
  if (hung) process.kill(pid, "SIGSTOP");
  proc.kill("SIGKILL");
  await proc.exited;
  const deadline = Date.now() + 10_000;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(250);
  const survived = alive(pid);
  if (survived) process.kill(pid, "SIGKILL");
  expect(survived).toBe(false);
}, 30_000);
