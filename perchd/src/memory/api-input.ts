/**
 * The envelope and input checks for the typed functions behind the Memory and Routines pages.
 * Input comes from WebUI, so every field is checked here and errors are plain sentences.
 */

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export class InputError extends Error {}

export async function attempt<T>(fn: () => Promise<T> | T): Promise<ApiResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("Expected an object.");
  return input as Record<string, unknown>;
}

export function text(input: Record<string, unknown>, key: string, opts: { max: number; optional?: boolean; label?: string }): string {
  const value = input[key];
  const label = opts.label ?? key;
  if (value === undefined || value === null || value === "") {
    if (opts.optional) return "";
    throw new InputError(`${label} is required.`);
  }
  if (typeof value !== "string") throw new InputError(`${label} must be text.`);
  const trimmed = value.trim();
  if (!trimmed && !opts.optional) throw new InputError(`${label} is required.`);
  if (trimmed.length > opts.max) throw new InputError(`${label} is too long (at most ${opts.max} characters).`);
  return trimmed;
}

export function flag(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new InputError(`${key} must be true or false.`);
  return value;
}

export function oneOf<T extends string>(input: Record<string, unknown>, key: string, allowed: readonly T[], fallback?: T): T {
  const value = input[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new InputError(`${key} must be one of: ${allowed.join(", ")}.`);
  return value as T;
}

export function int(input: Record<string, unknown>, key: string, opts: { min: number; max: number; fallback?: number }): number {
  const value = input[key];
  if (value === undefined && opts.fallback !== undefined) return opts.fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < opts.min || value > opts.max) throw new InputError(`${key} must be a whole number from ${opts.min} to ${opts.max}.`);
  return value;
}

export function id(input: Record<string, unknown>, key = "id"): string {
  const value = input[key];
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw new InputError(`${key} is not a valid id.`);
  return value;
}
