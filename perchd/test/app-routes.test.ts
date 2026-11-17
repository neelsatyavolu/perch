import { expect, test } from "bun:test";
import { match } from "../src/app/routes";

const chat = "b6ae9c16-56f1-45b1-8b9a-bb6c2654bef0";
const queued = "a11b8bef-1ff5-4eed-bd5e-805667570dfd";

test("a queued message can be sent now or removed", () => {
  const steer = match("POST", `/api/chats/${chat}/queue/${queued}/steer`);
  const remove = match("DELETE", `/api/chats/${chat}/queue/${queued}`);
  expect(steer && steer !== "method" ? steer.params : null).toEqual([chat, queued]);
  expect(remove && remove !== "method" ? remove.params : null).toEqual([chat, queued]);
});
