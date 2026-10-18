/**
 * API grants for sandboxed plugin bundles.
 *
 * A grant is `"METHOD /api/path"`. `*` matches one path segment and `**`
 * matches zero or more. Omitted grants mean read-only API access; `[]` denies
 * everything. Matching happens after URL normalisation so a bundle cannot use
 * `..` or encoded traversal to reach a route its grant does not cover.
 */

export const DEFAULT_WEB_API_GRANTS: readonly string[] = ["GET /api/**"];

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function matchSegments(pattern: string[], path: string[]): boolean {
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < path.length) {
    if (p < pattern.length && pattern[p] === "**") {
      star = p;
      mark = s;
      p += 1;
    } else if (p < pattern.length && (pattern[p] === "*" || pattern[p] === path[s])) {
      p += 1;
      s += 1;
    } else if (star !== -1) {
      p = star + 1;
      s = mark + 1;
      mark = s;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "**") p += 1;
  return p === pattern.length;
}

/** Returns the normalised path, or `undefined` when it must be rejected. */
export function normalizeApiPath(raw: string): string | undefined {
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.includes("\0")) {
    return undefined;
  }
  let url: URL;
  let decoded: string;
  try {
    url = new URL(raw, "http://kestrel.invalid");
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (decoded.split("/").some((part) => part === "." || part === "..")) return undefined;
  return url.pathname;
}

export function apiAllowed(grants: readonly string[] | undefined, method: string, rawPath: string): boolean {
  const path = normalizeApiPath(rawPath);
  if (!path) return false;
  const verb = method.toUpperCase();
  if (!METHODS.has(verb)) return false;
  const target = segments(path);
  for (const grant of grants ?? DEFAULT_WEB_API_GRANTS) {
    const parts = grant.trim().split(/\s+/);
    if (parts.length !== 2) continue;
    const [grantMethod, pattern] = parts;
    const allowedMethod = grantMethod === "*" ? "*" : grantMethod.toUpperCase();
    if (allowedMethod !== "*" && (!METHODS.has(allowedMethod) || allowedMethod !== verb)) continue;
    if (!pattern.startsWith("/api/")) continue;
    if (matchSegments(segments(pattern), target)) return true;
  }
  return false;
}
