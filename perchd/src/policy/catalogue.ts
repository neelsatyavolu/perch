/**
 * The Perch policy catalogue (spec 12.2), from enterprise/policies.json. The JSON is imported, so
 * the compiled perchd carries it and reads the same names the browser's policy schema has.
 */

import file from "../../../enterprise/policies.json" with { type: "json" };

export type PolicyType = "boolean" | "integer" | "string" | "list" | "dict";

/** The JSON-schema subset the catalogue uses (and Chromium's policy schema accepts). */
export type Schema = {
  type: "boolean" | "integer" | "string" | "array" | "object";
  enum?: readonly unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  items?: Schema;
  properties?: Readonly<Record<string, Schema>>;
  required?: readonly string[];
};

export type CatalogueEntry = { name: string; type: PolicyType; schema: Schema; default: unknown };

/** Chrome policies perchd also honours: SyncDisabled turns Perch's sync off, like SyncEnabled false. */
export const CHROME_POLICIES: readonly CatalogueEntry[] = [{ name: "SyncDisabled", type: "boolean", schema: { type: "boolean" }, default: false }];

export const CATALOGUE: readonly CatalogueEntry[] = Object.freeze(
  (file.policies as unknown as CatalogueEntry[]).map((p) => Object.freeze({ name: p.name, type: p.type, schema: p.schema, default: p.default })),
);

/** Every name perchd reads from the managed preferences. */
export const POLICY_NAMES: readonly string[] = [...CATALOGUE, ...CHROME_POLICIES].map((p) => p.name);
