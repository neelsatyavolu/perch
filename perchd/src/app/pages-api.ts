/**
 * ui-pages' `PerchApi` (ui-pages/src/api.ts) for Perch's own pages: every method the browser does
 * not answer itself. A page calls `POST /api/pages/<method>` with the arguments as a JSON array;
 * job progress goes out on the app WebSocket as `pages.event`. Each part delegates to the module
 * that owns the data (src/app/pages/*.ts).
 */

import { API_METHODS } from "../../../ui-pages/src/api";
import type { PagesDeps } from "./pages/deps";
import { importPages } from "./pages/import";
import { onePasswordPages } from "./pages/onepassword";
import { mcpPages } from "./pages/mcp";
import { memoryPages } from "./pages/memory";
import { modelsPages } from "./pages/models";
import { ntpPages } from "./pages/ntp";
import { permissionsPages } from "./pages/permissions";
import { agentsPages } from "./pages/agents";
import { memoryChatPages } from "./pages/memory-chat";
import { auditPages } from "./pages/audit";
import { policyPages } from "./pages/policy";
import { capMode } from "../policy/policy";
import { profilePages } from "./pages/profile";
import { routinesPages } from "./pages/routines";
import { skillsPages } from "./pages/skills";
import { syncPages } from "./pages/sync";
import { policyOf, type ApiMethod, type Methods } from "./pages/common";
import { AppError } from "./runs";
import * as v from "./validate";

/** Methods the browser answers itself (appearance, privacy, site data, navigation, files, updates). */
export const BROWSER_METHODS = [
  "getAppearance", "setAppearance", "getPrivacy", "setPrivacy", "setBackgroundConnection", "removeBlockerException", "listSiteData", "forgetSite",
  "openPage", "chooseFile", "openFullDiskAccess", "restartPerch", "getAbout", "checkForUpdates", "installUpdate", "setAutoUpdate",
  "submitQuery", "autocompleteAddress", "openAddress", "openChat", "newChat",
  "listBuiltInExtensions", "setBuiltInExtension",
  "getMemorySaver", "setMemorySaver", "addSleepRule", "listTabMemory",
  "queryCommandBar", "runCommandBarItem", "closeCommandBar", "openCommandBar", "showAgentTab", "showThisTab", "finishTour", "getProfile", "setProfile", "setProfilePicture",
  "revealRecoveryKey", "getSecurity", "exportBackup", "restoreFromRecoveryKey", "startFresh",
] as const satisfies readonly ApiMethod[];

export type PerchdMethod = Exclude<(typeof API_METHODS)[number], (typeof BROWSER_METHODS)[number]>;
export const PERCHD_METHODS: readonly PerchdMethod[] = API_METHODS.filter((m): m is PerchdMethod => !(BROWSER_METHODS as readonly string[]).includes(m));

/** How many arguments each method takes at most; the rest take none. */
const ARITY: Partial<Record<PerchdMethod, number>> = {
  setNtpLayout: 1, listChats: 1, searchChats: 1, dismissSuggestion: 1, setComposer: 1,
  signIn: 1, finishSignIn: 2, signOut: 1, connectProvider: 1, setTaskModel: 2,
  importMcpServers: 1, addMcpServer: 1, updateMcpServer: 2, removeMcpServer: 1, addSkill: 1, setSkillEnabled: 2, removeSkill: 1,
  setPermissionMode: 1, addSiteRule: 1, removeSiteRule: 1, setClientMode: 2, listAuditLog: 1, exportAuditLog: 1,
  setMemorySettings: 1, readMemoryPage: 1, writeMemoryPage: 2, deleteMemoryPage: 1, listDreamLogs: 1,
  startProfileBuild: 2, saveProfileDraft: 1,
  saveRoutine: 1, setRoutineEnabled: 2, deleteRoutine: 1, runRoutine: 1, acceptProposal: 1, dismissProposal: 1,
  startImport: 1, getJob: 1, completeOnboardingStep: 1, setOnePassword: 1, listOnePasswordVaults: 1,
  checkSyncPairing: 1, removeSyncDevice: 1,
};

export type PagesApi = { call(method: string, args: unknown): Promise<unknown> };

export function createPagesApi(deps: PagesDeps): PagesApi {
  const profile = profilePages(deps);
  const { forget, ...profileMethods } = profile;
  const methods = {
    ...ntpPages(deps),
    ...modelsPages(deps),
    ...mcpPages(deps),
    ...skillsPages(deps),
    ...permissionsPages(deps),
    ...agentsPages(deps),
    ...memoryChatPages(deps),
    ...auditPages(deps),
    ...policyPages(deps),
    ...memoryPages(deps, forget),
    ...profileMethods,
    ...routinesPages(deps),
    ...importPages(deps),
    ...onePasswordPages(deps),
    ...syncPages(deps),
    getJob: async ([id]) => deps.jobs.get(v.text(id, "id", 100)),
  } satisfies Methods<PerchdMethod>;
  const known = new Set<string>(PERCHD_METHODS);
  void deps.state.get().then(
    (s) => deps.setDefaults?.({ mode: capMode(s.mode, policyOf(deps)), ...(s.chatModel ? { model: s.chatModel } : {}), ...(s.chatEffort ? { effort: s.chatEffort } : {}) }),
    () => undefined,
  );

  return {
    async call(method, args) {
      if (!known.has(method)) throw new AppError("not found", 404);
      const name = method as PerchdMethod;
      const result = await methods[name](v.args(args, ARITY[name] ?? 0));
      return result ?? null;
    },
  };
}
