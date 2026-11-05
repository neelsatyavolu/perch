import { afterAll, beforeAll, expect, test } from "bun:test";
import { clickAt, screenshot, typeText } from "../src/page/screenshot";
import { repl } from "../src/page/repl";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.teardown(); });

/** Decodes a JPEG with the browser itself and returns the RGB at a CSS pixel. */
async function pixel(jpegBase64: string, x: number, y: number): Promise<[number, number, number]> {
  const tab = await env.browser.newTab();
  const rgb = await tab.evaluate<[number, number, number]>(`new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(${Math.round(x)}, ${Math.round(y)}, 1, 1).data; resolve([d[0], d[1], d[2]]);
    };
    img.src = 'data:image/jpeg;base64,${jpegBase64}';
  })`);
  await tab.close();
  return rgb;
}

test("screenshots cover filled secret fields and remove the cover afterwards", async () => {
  const tab = await env.browser.newTab(env.site.url("/form.html"));
  await tab.evaluate("document.getElementById('password').focus()");
  await tab.send("Input.insertText", { text: "hunter2-secret" });
  const box = await tab.evaluate<{ x: number; y: number }>(
    "(() => { const r = document.getElementById('password').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()",
  );
  const shot = await screenshot(tab);
  expect(shot.width).toBeGreaterThan(300);
  const [r, g, b] = await pixel(shot.jpegBase64, box.x, box.y);
  expect(r + g + b).toBeLessThan(60);
  expect(await tab.evaluate<number>("document.querySelectorAll('[data-perch-mask]').length")).toBe(0);
  await tab.close();
});

test("clickAt and typeText act at coordinates", async () => {
  const tab = await env.browser.newTab(env.site.url("/form.html"));
  const signIn = await tab.evaluate<{ x: number; y: number }>(
    "(() => { const r = document.getElementById('signin').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()",
  );
  expect(await clickAt(tab, signIn.x, signIn.y)).toMatchObject({ ok: true });
  expect(await tab.evaluate<string>("document.getElementById('status').textContent")).toBe("Signed in");
  await tab.evaluate("document.getElementById('email').focus()");
  expect(await typeText(tab, "neel@example.com")).toMatchObject({ ok: true });
  expect(await tab.evaluate<string>("document.getElementById('email').value")).toBe("neel@example.com");
  await tab.close();
});

test("the REPL runs code but cannot read secret fields", async () => {
  const tab = await env.browser.newTab(env.site.url("/form.html"));
  await tab.evaluate("document.getElementById('password').focus()");
  await tab.send("Input.insertText", { text: "hunter2-secret" });
  expect(await repl(tab, "document.title")).toEqual({ result: "Sign in" });
  expect(await repl(tab, "return [...document.querySelectorAll('label')].length")).toEqual({ result: 6 });
  expect(await repl(tab, "document.getElementById('password').value")).toEqual({ result: undefined, error: "secret field" });
  const viaForm = await repl(tab, "const f = document.createElement('form'); f.append(document.getElementById('password').cloneNode()); return [...new FormData(f).keys()]");
  expect(JSON.stringify(viaForm)).not.toContain("hunter2");
  expect(await repl(tab, "throw new Error('boom')")).toEqual({ result: undefined, error: "boom" });
  await tab.close();
});
