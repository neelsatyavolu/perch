// Perch's copy of Caveatly sends nothing: this replaces src/lib/heartbeat.js when Caveatly is built in.
export const HEARTBEAT_URL = '';
export const UNINSTALL_URL = '';
export async function syncUninstallUrl() {}
export function maybeSendHeartbeat() {
  return Promise.resolve(false);
}
