import type { Context } from "hono";
import { z } from "zod";

/** An error with a status and a message safe to show to the person using Perch. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const SMALL_BODY = 16 * 1024;

/**
 * Reads a JSON body and checks it against a schema. Requires `application/json`, which an HTML
 * form on another site cannot send, and caps the size before parsing.
 */
export async function readJson<T extends z.ZodType>(c: Context, schema: T, maxBytes = SMALL_BODY): Promise<z.infer<T>> {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type)) throw new HttpError(415, "unsupported_type", "Send the request body as application/json.");
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > maxBytes) throw tooLarge();
  const text = await c.req.text();
  if (text.length > maxBytes) throw tooLarge();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_json", "The request body is not valid JSON.");
  }
  return check(schema, value);
}

/** Checks a value (query, params or body) against a schema, with a 400 that names the field. */
export function check<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.length ? issue.path.join(".") : "body";
  throw new HttpError(400, "invalid_input", `Invalid ${where}: ${issue?.message ?? "not accepted"}.`);
}

const tooLarge = () => new HttpError(413, "too_large", "The request body is too large.");

/** The caller's IP, as Cloudflare reports it. Only ever used hashed, as a rate-limit key. */
export const clientIp = (c: Context): string => c.req.header("cf-connecting-ip") ?? "unknown";

/** Shared input shapes. */
export const base64url = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/, "must be base64url");
export const publicKeySchema = base64url(120).refine((s) => s.length === 87, "must be a raw P-256 public key");
export const deviceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\p{L}\p{N} '’._()-]+$/u, "may use letters, numbers, spaces and . _ ( ) - ' only");
export const deviceKindSchema = z.enum(["browser", "cli", "assistant"]);
export const deviceSchema = z.object({ name: deviceNameSchema, kind: deviceKindSchema, publicKey: publicKeySchema }).strict();
export type DeviceInput = z.infer<typeof deviceSchema>;
export const idSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/, "is not a valid id");
