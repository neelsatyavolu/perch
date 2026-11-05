/** Removes tracking parameters from URLs: a pure function for copied links, and the DNR rule for page loads. */

import type { Rule } from "../rules/compile";
import { PRIORITY } from "../rules/limits";
import { TRACKING_PARAMS } from "./list";

const NAMES = new Set(TRACKING_PARAMS);

export function isTrackingParam(name: string): boolean {
  return NAMES.has(name) || /^utm_[a-z0-9_-]+$/i.test(name);
}

/** Returns the URL without tracking parameters; anything that is not an http(s) URL comes back unchanged. */
export function stripTrackingParams(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return href;
  if (!url.search) return href;
  const pairs = url.search.slice(1).split("&");
  const kept = pairs.filter((pair) => !isTrackingParam(decodeName(pair)));
  if (kept.length === pairs.length) return href;
  url.search = kept.length ? `?${kept.join("&")}` : "";
  return url.href;
}

function decodeName(pair: string): string {
  const name = pair.split("=", 1)[0] ?? "";
  try {
    return decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return name;
  }
}

/**
 * The static `params` ruleset. DNR's removeParams takes exact names only, so utm_* is the listed
 * set; the copy and preview paths also catch unlisted utm_ names. Chrome does not redirect when
 * the transform leaves the URL unchanged, so clean URLs load with no extra hop.
 */
export function paramRules(): Rule[] {
  return [
    {
      id: 1,
      priority: PRIORITY.params,
      action: { type: "redirect", redirect: { transform: { queryTransform: { removeParams: [...TRACKING_PARAMS] } } } },
      condition: { resourceTypes: ["main_frame", "sub_frame"] },
    },
  ];
}
