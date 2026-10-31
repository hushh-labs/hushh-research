import { normalizeStaticExportPathname } from "@/lib/navigation/routes";

/** Logical route identity, independent of native static-export transport. */
export function appRouteMatches(
  current: string,
  expected: string,
  exactQuery = false,
): boolean {
  if (!current || !expected) return false;
  try {
    const actual = new URL(current, "https://app.invalid");
    const target = new URL(expected, "https://app.invalid");
    if (actual.origin !== target.origin) return false;
    if (
      normalizeStaticExportPathname(actual.pathname) !==
      normalizeStaticExportPathname(target.pathname)
    )
      return false;
    if (!exactQuery && !target.search) return true;
    actual.searchParams.sort();
    target.searchParams.sort();
    return actual.searchParams.toString() === target.searchParams.toString();
  } catch {
    return false;
  }
}
