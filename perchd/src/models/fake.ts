/** A scripted model for tests: each turn plays the next step, a list of events or a function of the request. */

import type { Model, TurnEvent, TurnRequest } from "./types";

export type FakeStep = TurnEvent[] | ((req: TurnRequest) => TurnEvent[]);
export type FakeModel = Model & { requests: TurnRequest[] };

export function fakeModel(script: FakeStep[] | ((req: TurnRequest, turn: number) => TurnEvent[])): FakeModel {
  let index = 0;
  const requests: TurnRequest[] = [];
  return {
    id: "fake",
    requests,
    async *turn(req: TurnRequest): AsyncIterable<TurnEvent> {
      requests.push(structuredClone(req));
      const turn = index++;
      const step = typeof script === "function" ? script : script[turn];
      if (!step) throw new Error("the fake model's script ran out");
      const events = typeof step === "function" ? step(req, turn) : step;
      for (const event of events) yield event;
    },
  };
}
