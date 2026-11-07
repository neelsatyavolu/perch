/**
 * What Settings needs to lock the rows a company policy controls (spec 12.2): whether anything is
 * managed, the values in force, and the problems perch://policy and Settings report (a value that
 * failed its schema, an AuditLogPath Perch cannot write).
 */

import type { PolicyState } from "../../../../ui-pages/src/api";
import { isManaged } from "../../policy/policy";
import { policyOf, type Methods } from "./common";
import type { PagesDeps } from "./deps";

export function policyPages(deps: PagesDeps): Methods<"getPolicy"> {
  return {
    async getPolicy(): Promise<PolicyState> {
      const values = policyOf(deps);
      const errors = [...(deps.policy?.errors?.() ?? []), ...(deps.policyProblems?.() ?? [])];
      return { managed: isManaged(values) || errors.length > 0, values: { ...values }, errors: errors.map((e) => ({ name: e.name, message: e.message })) };
    },
  };
}
