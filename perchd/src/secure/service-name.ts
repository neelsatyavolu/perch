/**
 * Keychain service names for Perch's own items. A development run sets PERCH_KEYCHAIN_SUFFIX so its
 * items never share a name with the installed app's: the installed agent would otherwise find them
 * at launch, take them for its own older items, and ask the user to allow each one. The suffix may
 * use letters, digits, dots, dashes and underscores (what every Keychain store here accepts in a
 * name); anything else is ignored.
 */

const OWN = /^(Perch( |$)|com\.perch\.|co\.xanom\.perch)/;

export function ownService(service: string, env: Record<string, string | undefined> = process.env): string {
  const suffix = env.PERCH_KEYCHAIN_SUFFIX;
  // Another browser's "Safe Storage" item is read during import and is never renamed.
  if (!suffix || !/^[A-Za-z0-9._-]{1,16}$/.test(suffix) || !OWN.test(service) || service.endsWith("Safe Storage") || service.endsWith(suffix)) return service;
  return `${service}${suffix}`;
}
