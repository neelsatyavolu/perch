/**
 * Checks a policy value against its catalogue schema. A value either passes whole or fails with a
 * plain reason; nothing is half-applied. Unknown keys in a dictionary are dropped, as Chromium does.
 */

import type { Schema } from "./catalogue";

export type Checked = { ok: true; value: unknown } | { ok: false; message: string };

const MAX_DEPTH = 6;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function fail(message: string): Checked {
  return { ok: false, message };
}

export function check(value: unknown, schema: Schema, where = "the value", depth = 0): Checked {
  if (depth > MAX_DEPTH) return fail(`${where} is nested too deeply`);
  switch (schema.type) {
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : fail(`${where} must be true or false`);
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return fail(`${where} must be a whole number`);
      if (schema.minimum !== undefined && value < schema.minimum) return fail(`${where} must be at least ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) return fail(`${where} must be at most ${schema.maximum}`);
      return { ok: true, value };
    case "string":
      if (typeof value !== "string") return fail(`${where} must be text`);
      if (schema.enum && !schema.enum.includes(value)) return fail(`${where} must be one of ${schema.enum.join(", ")}`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) return fail(`${where} is not in the expected form`);
      return { ok: true, value };
    case "array": {
      if (!Array.isArray(value)) return fail(`${where} must be a list`);
      const items: unknown[] = [];
      for (const [i, item] of value.entries()) {
        const r = schema.items ? check(item, schema.items, `item ${i + 1} of ${where}`, depth + 1) : { ok: true as const, value: item };
        if (!r.ok) return r;
        items.push(r.value);
      }
      return { ok: true, value: items };
    }
    case "object": {
      if (!isRecord(value)) return fail(`${where} must be a dictionary`);
      const missing = (schema.required ?? []).find((k) => !(k in value));
      if (missing) return fail(`${where} needs "${missing}"`);
      const out: Record<string, unknown> = {};
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (!(key in value)) continue;
        const r = check(value[key], sub, `"${key}" in ${where}`, depth + 1);
        if (!r.ok) return r;
        out[key] = r.value;
      }
      return { ok: true, value: out };
    }
  }
}
