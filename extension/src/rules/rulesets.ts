/** The filter lists the blocker compiles, by ruleset id, in budget order. Shared by the build, the service worker and the pages. */

export const FILTER_LISTS = {
  easylist: "EasyList",
  easyprivacy: "EasyPrivacy",
  "ubo-privacy": "uBlock filters – Privacy",
} as const;

export type FilterListId = keyof typeof FILTER_LISTS;

export const FILTER_RULESET_IDS = Object.keys(FILTER_LISTS) as FilterListId[];

export function isFilterRuleset(id: string): id is FilterListId {
  return Object.hasOwn(FILTER_LISTS, id);
}
