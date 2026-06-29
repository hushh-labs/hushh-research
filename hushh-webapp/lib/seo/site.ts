/**
 * SEO site configuration.
 *
 * Single source of truth for the canonical site origin and the set of public,
 * indexable marketing/entry routes. Authenticated product surfaces (the vault,
 * portfolio, PKM, agent workspaces, etc.) are intentionally excluded so they
 * are never indexed.
 *
 * Note on native builds: under Capacitor static export (CAPACITOR_BUILD=true)
 * the app uses `output: "export"`, which does not emit dynamic route handlers
 * like `robots.ts` / `sitemap.ts`. These therefore apply to the web build only,
 * which is the correct scope for crawler directives.
 */

/** Canonical production origin. Mirrors `metadataBase` in the root layout. */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://hushh.ai"
).replace(/\/$/, "");

/**
 * Public, indexable routes. Keep this list aligned with marketing/entry
 * surfaces only. Do NOT add authenticated or per-user product routes.
 */
export const PUBLIC_ROUTES = [
  "/",
  "/getting-started",
  "/login",
  "/marketplace",
  "/developers",
] as const;

export type PublicRoute = (typeof PUBLIC_ROUTES)[number];

/**
 * Path prefixes that must never be indexed. Used by robots to disallow
 * authenticated product surfaces and machine endpoints.
 */
export const DISALLOWED_PREFIXES = [
  "/api/",
  "/agent",
  "/one",
  "/kai",
  "/ria",
  "/pkm",
  "/portfolio",
  "/profile",
  "/consents",
  "/connected-systems",
  "/gmail",
  "/logout",
  "/register-phone",
  "/labs",
] as const;

/** Build an absolute URL for a site-relative path. */
export function absoluteUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${SITE_URL}${suffix}`;
}
