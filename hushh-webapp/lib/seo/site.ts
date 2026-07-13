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
  "/marketplace",
  "/developers",
  "/research",
  "/research/protocol",
  "/blog",
] as const;

export type PublicRoute = (typeof PUBLIC_ROUTES)[number];

export type PublicRouteSemantic = {
  title: string;
  description: string;
  schemaType: "WebPage" | "CollectionPage";
  voicePlaybookId: string;
};

/**
 * Public search/answer semantics. Voice playbooks share the stable route and
 * playbook identity, but their runtime instructions are never copied into
 * crawler markup. A parity test keeps this editorial projection aligned.
 */
export const PUBLIC_ROUTE_SEMANTICS: Record<PublicRoute, PublicRouteSemantic> = {
  "/": {
    title: "Hussh One | Your Private Agent",
    description: "Private AI agents with consent at the core. Your information, your control.",
    schemaType: "WebPage",
    voicePlaybookId: "route.one.intro",
  },
  "/getting-started": {
    title: "Get started with Hussh One",
    description: "Understand how to claim and set up your private agent with consent-first controls.",
    schemaType: "WebPage",
    voicePlaybookId: "route.getting.started",
  },
  "/marketplace": {
    title: "Hussh Information Marketplace",
    description: "Explore consent-first exchanges governed by scoped access and owner control.",
    schemaType: "WebPage",
    voicePlaybookId: "route.marketplace",
  },
  "/developers": {
    title: "Hussh Developers",
    description: "Build consent-first agent experiences with Hussh protocols and developer tools.",
    schemaType: "WebPage",
    voicePlaybookId: "route.developers",
  },
  "/research": {
    title: "Research & Papers | Hussh",
    description: "Open consent protocols and research from Hussh, including PCHP.",
    schemaType: "CollectionPage",
    voicePlaybookId: "route.research",
  },
  "/research/protocol": {
    title: "Personal Consent Handshake Protocol | Hussh Research",
    description: "Read the open protocol for explicit, scoped, auditable consent between people and agents.",
    schemaType: "WebPage",
    voicePlaybookId: "route.research.protocol",
  },
  "/blog": {
    title: "Hussh Research Blog",
    description: "Writing on consent-first information sharing, private agents, and human-centered systems.",
    schemaType: "CollectionPage",
    voicePlaybookId: "route.blog",
  },
};

/**
 * Path prefixes that must never be indexed. Used by robots to disallow
 * authenticated product surfaces and machine endpoints.
 */
export const DISALLOWED_PREFIXES = [
  "/api/",
  "/login",
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
