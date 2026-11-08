import { expect, test } from "bun:test";
import { fakeModel } from "../src/models/fake";
import { findProposals, type Ask } from "../src/routines/suggest";

const now = new Date(2026, 10, 8, 12, 0); // Sunday 8 Nov 2026, local time
const at = (daysAgo: number, h: number, m = 0) => new Date(2026, 10, 8 - daysAgo, h, m).toISOString();

const asks: Ask[] = [
  { chatId: "c1", text: "Summarise my unread email", time: at(2, 8, 5) }, // Fri
  { chatId: "c2", text: "summarise my unread email!", time: at(5, 8, 20) }, // Tue
  { chatId: "c3", text: "Book a table for two at Nopa", time: at(3, 19) },
  { chatId: "c4", text: "What's new in my inbox?", time: at(6, 8, 10) }, // Mon
  { chatId: "c5", text: "Summarise my unread email", time: at(45, 8) }, // outside the window
];

test("without a model, the same request twice in 30 days is one proposal with its usual time", async () => {
  const found = await findProposals({ asks, now });
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ times: 2, chatIds: ["c2", "c1"], schedule: { kind: "daily", time: "08:15", days: ["mon", "tue", "wed", "thu", "fri"] } });
  expect(found[0]!.evidence).toContain("2 times in the last 30 days");
});

test("the fast model groups different wordings; groups of one, and made-up request numbers, are dropped", async () => {
  const model = fakeModel(() => [
    { type: "tool_call", call: { id: "1", name: "propose_routines", args: { groups: [
      { title: "Morning inbox summary", task: "Summarise my unread email", asks: [1, 2, 3], time: "08:00" },
      { title: "Dinner", task: "Book a table", asks: [99, 2] },
    ] } } },
    { type: "done" },
  ]);
  const found = await findProposals({ asks, now, model });
  expect(found).toEqual([expect.objectContaining({ title: "Morning inbox summary", times: 3, schedule: { kind: "daily", time: "08:00", days: ["mon", "tue", "wed", "thu", "fri"] } })]);
  const prompt = model.requests[0]!.messages[0]!;
  expect(JSON.stringify(prompt)).not.toContain("45");
  expect(JSON.stringify(prompt)).toContain("Book a table for two at Nopa");
});

test("a model that answers without the tool falls back to same-words groups", async () => {
  const model = fakeModel(() => [{ type: "text", delta: "no" }, { type: "done" }]);
  expect((await findProposals({ asks, now, model })).map((p) => p.times)).toEqual([2]);
});

test("fewer than two chats in the window proposes nothing and never calls the model", async () => {
  const model = fakeModel([]);
  expect(await findProposals({ asks: asks.slice(0, 1), now, model })).toEqual([]);
  expect(model.requests).toHaveLength(0);
});
