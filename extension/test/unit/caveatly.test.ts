import { expect, test } from "bun:test";
import { blockerState, CAVEATLY_ID, isCaveatlyAsking, syncCaveatly } from "../../src/background/caveatly";
import { DEFAULT_SETTINGS } from "../../src/shared/settings";

test("Caveatly gets Perch's blocker switch and the sites protections are off for", async () => {
  const settings = { ...DEFAULT_SETTINGS, blocker: true, sitesOff: ["example.com"] };
  const sent: unknown[][] = [];
  await syncCaveatly(settings, (async (...args: unknown[]) => void sent.push(args)) as never);
  expect(sent).toEqual([[CAVEATLY_ID, { type: "perch.blocker", on: true, sitesOff: ["example.com"] }]]);
  expect(blockerState({ ...settings, blocker: false })).toMatchObject({ on: false });
});

test("Caveatly not running is fine: it asks when it starts", async () => {
  await syncCaveatly(DEFAULT_SETTINGS, (async () => { throw new Error("Could not establish connection"); }) as never);
});

test("only Caveatly's own ready message is answered", () => {
  expect(isCaveatlyAsking({ type: "caveatly.ready" }, { id: CAVEATLY_ID })).toBe(true);
  expect(isCaveatlyAsking({ type: "caveatly.ready" }, { id: "someotherextensionidaaaaaaaaaaaa" })).toBe(false);
  expect(isCaveatlyAsking({ type: "other" }, { id: CAVEATLY_ID })).toBe(false);
});
