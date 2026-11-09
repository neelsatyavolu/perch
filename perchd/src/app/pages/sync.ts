/**
 * Settings › Sync (plan 3b task 14): pairing this Mac, the devices on the account, and a pass now.
 * The recovery key is the browser's to show (after Touch ID), never perchd's.
 */

import { syncAllowed } from "../../policy/policy";
import { SYNC_OFF } from "../../sync/policy";
import { managed, plainly, policyOf, type Methods } from "./common";
import type { PagesDeps } from "./deps";
import { AppError } from "../runs";
import * as v from "../validate";

type SyncMethod = "getSync" | "startSyncPairing" | "checkSyncPairing" | "syncNow" | "removeSyncDevice" | "turnOffSync";

export function syncPages(deps: PagesDeps): Methods<SyncMethod> {
  const service = () => {
    if (!deps.sync) throw new AppError("Sync works inside Perch.", 501);
    return deps.sync;
  };
  const allowed = () => {
    if (!syncAllowed(policyOf(deps))) managed(SYNC_OFF);
    return service();
  };
  return {
    getSync: async () => service().status(),
    startSyncPairing: async () => plainly(() => allowed().startPairing()),
    checkSyncPairing: async ([id]) => {
      const sync = allowed();
      const paired = await plainly(() => sync.checkPairing(v.text(id, "pairingId", 200)));
      if (!paired) return null;
      void sync.syncNow().catch(() => undefined);
      return sync.status();
    },
    syncNow: async () => {
      const sync = allowed();
      await sync.syncNow();
      return sync.status();
    },
    removeSyncDevice: async ([id]) => {
      const sync = service();
      await plainly(() => sync.removeDevice(v.text(id, "id", 200)));
      return sync.status();
    },
    turnOffSync: async () => {
      const sync = service();
      await plainly(() => sync.turnOff());
      return sync.status();
    },
  };
}
