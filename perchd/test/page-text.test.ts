import { expect, test } from "bun:test";
import { pageTextContext, readPageText } from "../src/app/page-text";
import { CdpConnection } from "../src/cdp/connection";

test("page text goes in with the selection first, and says when it was cut", () => {
  const ctx = pageTextContext({ selection: "f'(x) = 2x", text: "Unit 3 practice\nQuestion 1", more: true });
  expect(ctx.indexOf("selected")).toBeLessThan(ctx.indexOf("Unit 3 practice"));
  expect(ctx).toContain("first 6000 characters");
  expect(ctx).toContain("snapshot before clicking");
  expect(pageTextContext({ selection: "", text: "", more: false })).toBe("");
});

test("a tab that never answers gives no page text, and its session is let go", async () => {
  const sent: string[] = [];
  const conn: CdpConnection = new CdpConnection(
    (message) => {
      const { id, method } = message as { id: number; method: string };
      sent.push(method);
      // The page attaches but never evaluates anything: a frozen page.
      if (method === "Target.attachToTarget") queueMicrotask(() => conn.handle({ id, result: { sessionId: "S1" } }));
      if (method === "Target.detachFromTarget") queueMicrotask(() => conn.handle({ id, result: {} }));
    },
    async () => undefined,
  );
  expect(await readPageText(conn, "T1")).toBeNull();
  await Bun.sleep(10);
  expect(sent).toEqual(["Target.attachToTarget", "Runtime.evaluate", "Target.detachFromTarget"]);
});
