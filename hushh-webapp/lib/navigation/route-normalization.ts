/** Import-safe canonicalization shared by route builders and admission. */
export function normalizeInternalRouteHref(
  value: string | null | undefined,
): string | null {
  const href = String(value ?? "").trim();
  if (!href) return null;
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(href) || /%5c/i.test(href)) return null;
  try {
    const parsed = new URL(href, "https://one.local");
    if (parsed.origin !== "https://one.local") return null;
    const canonical = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return canonical === href ? canonical : null;
  } catch {
    return null;
  }
}

export function resolveInternalRouteHref(
  value: string | null | undefined,
  fallback: string,
): string {
  return normalizeInternalRouteHref(value) ?? fallback;
}

export function normalizeStaticExportPathname(pathname: string): string {
  const withoutIndexDocument = String(pathname || "/").replace(
    /\/index\.html$/i,
    "",
  );
  const withoutTrailingSlash = withoutIndexDocument.replace(/\/+$/, "");
  return withoutTrailingSlash || "/";
}

