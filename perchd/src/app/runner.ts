/** The app's runner: Perch's own agent loop with the chat's model, mode and effort. */

import type { AuditLog } from "../agent/audit";
import { withoutPageText } from "../agent/audit-seal";
import { runTask, type StepEvent } from "../agent/loop";
import type { SiteRule } from "../agent/permissions";
import type { Browser } from "../browser/browser";
import type { Model } from "../models/types";
import type { PolicyView } from "../policy/policy";
import type { Runner } from "./runs";

export type LoopRunnerOptions = {
  browser: () => Promise<Browser>;
  /** The model for an id from the catalog, or a sentence saying why it cannot be used now. */
  model: (id: string) => Promise<Model | string>;
  audit: AuditLog;
  siteRule?: (host: string) => SiteRule | undefined;
  maxSteps?: number;
  /** Company policy: the agent on or off, the mode cap and site rules, applied before each action. */
  policy?: PolicyView;
};

export function loopRunner(opts: LoopRunnerOptions): Runner {
  return async function* (input): AsyncIterable<StepEvent> {
    const model = await opts.model(input.settings.model);
    if (typeof model === "string") {
      yield { type: "error", message: model };
      return;
    }
    yield* runTask({
      model,
      browser: await opts.browser(),
      task: input.task,
      mode: input.settings.mode,
      effort: input.settings.effort,
      approve: input.approve,
      audit: input.incognito ? withoutPageText(opts.audit) : opts.audit,
      client: "sidebar",
      siteRule: opts.siteRule,
      signal: input.signal,
      maxSteps: opts.maxSteps,
      ...(opts.policy ? { policy: opts.policy } : {}),
    });
  };
}
