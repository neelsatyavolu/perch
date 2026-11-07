/** The streaming services that need Widevine (spec 5.2), by the hosts their players run on. */

export const DRM_SERVICES: readonly { id: string; name: string; hosts: readonly string[] }[] = [
  { id: "netflix", name: "Netflix", hosts: ["netflix.com"] },
  { id: "hulu", name: "Hulu", hosts: ["hulu.com"] },
  { id: "disney", name: "Disney+", hosts: ["disneyplus.com"] },
  { id: "prime", name: "Prime Video", hosts: ["primevideo.com", "amazon.com"] },
  { id: "peacock", name: "Peacock", hosts: ["peacocktv.com"] },
  { id: "max", name: "Max", hosts: ["max.com", "hbomax.com"] },
  { id: "f1tv", name: "F1 TV", hosts: ["f1tv.formula1.com"] },
];

/** Content-script match patterns for every service host and its subdomains. */
export const DRM_MATCHES: readonly string[] = DRM_SERVICES.flatMap((s) => s.hosts.flatMap((h) => [`https://${h}/*`, `https://*.${h}/*`]));

export function serviceFor(hostname: string): { id: string; name: string } | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const found = DRM_SERVICES.find((s) => s.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
  return found ? { id: found.id, name: found.name } : null;
}

/** Key statuses that mean the licence was refused for this browser rather than the title. */
export const REFUSED_STATUSES: ReadonlySet<string> = new Set(["output-restricted", "internal-error"]);

export const DRM_EVENT = "perch-drm-refused";

export function noticeText(name: string): string {
  return `${name} won't play in this build. Google hasn't approved Perch's video signature yet`;
}
