/**
 * What every part of the pages API shares: the method types taken from ui-pages' `PerchApi`, so
 * each handler is checked against the contract, and the errors pages show.
 */

import type { ApiResult } from "../../memory/api-input";
import type { PerchApi } from "../../../../ui-pages/src/api";
import { AppError } from "../runs";

export type ApiMethod = Exclude<keyof PerchApi, "watchJob">;
export type Result<M extends ApiMethod> = Awaited<ReturnType<PerchApi[M]>>;
/** Handlers take the page's raw argument array and check it themselves. */
export type Methods<M extends ApiMethod> = { readonly [K in M]: (args: readonly unknown[]) => Promise<Result<K>> };

/** A method perchd cannot back yet: the page shows the message. */
export function notYet(message: string): never {
  throw new AppError(message, 501);
}

export function gone(message: string): never {
  throw new AppError(message, 404);
}

/** Runs a module call whose errors are plain sentences meant for the person, as a 400. */
export async function plainly<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(error instanceof Error ? error.message : String(error));
  }
}

/** The data of a memory or routines API result, or its error as a 400. */
export function ok<T>(result: ApiResult<T>): T {
  if (!result.ok) throw new AppError(result.error);
  return result.data;
}

export function capitalize(text: string): string {
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}
