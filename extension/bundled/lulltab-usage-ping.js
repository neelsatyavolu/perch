// Perch's copy of Lulltab sends nothing: this replaces lib/usage-ping.js when Lulltab is built in.
export const PRODUCT = "lulltab";
export const PING_URL = "";
export const UNINSTALL_URL = "";
export function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}
export function chromeMajor() {
  return "unknown";
}
export function normalizeArch(arch) {
  return arch || "unknown";
}
export function buildPayload() {
  return null;
}
export async function maybeSendPing() {
  return false;
}
export async function syncUninstallUrl() {}
