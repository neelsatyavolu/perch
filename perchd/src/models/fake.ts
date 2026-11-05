/** A scripted model for tests: each turn plays the next list of events. */

import type { Model, TurnEvent, TurnRequest } from "./types";

export type FakeModel = Model & { requests: TurnRequest[] };

export function fakeModel(script: TurnEvent[][]): FakeModel {
  let index = 0;
  const requests: TurnRequest[] = [];
  return {
    id: "fake",
    requests,
    async *turn(req: TurnRequest): AsyncIterable<TurnEvent> {
      requests.push(structuredClone(req));
      const events = script[index++];
      if (!events) throw new Error("the fake model's script ran out");
      for (const event of events) yield event;
    },
  };
}
