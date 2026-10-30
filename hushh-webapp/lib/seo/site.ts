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

/** Canonical application origin; public brand pages are owned by www.hussh.si. */
export function canonicalSiteUrl(raw = process.env.NEXT_PUBLIC_APP_URL): string {
  if (!raw) return "https://one.hussh.si";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return "https://one.hussh.si";
    const host = url.hostname.replace(/\.(?:hushh\.ai|hussh\.ai|hussh\.si)$/, ".hussh.si");
    if (!["one.hussh.si", "uat.one.hussh.si", "dev.one.hussh.si"].includes(host)) return "https://one.hussh.si";
    return `https://${host}`;
  } catch {
    return "https://one.hussh.si";
  }
}

export const SITE_URL = canonicalSiteUrl();

/** No implicit production indexing from NODE_ENV, which also marks UAT builds. */
export function isProductionIndexing(): boolean {
  return process.env.NEXT_PUBLIC_APP_ENV === "production";
}

/** Redirect-only public entrypoints share their existing rendered destinations. */
export const PUBLIC_CANONICAL_PATHS: Readonly<Record<string, string>> = {
  "/developers": "/welcome?tab=developers",
  "/research": "/welcome?tab=research",
  "/blog": "/welcome?tab=blog",
};

/**
 * Public, indexable routes. Keep this list aligned with marketing/entry
 * surfaces only. Do NOT add authenticated or per-user product routes.
 */
export const PUBLIC_ROUTES = [
  "/",
  "/marketplace",
  "/developers",
  "/research",
  "/research/protocol",
  "/blog",
  "/manishhussh",
] as const;

/** Public legal documents have no product-agent interaction contract. */
export const PUBLIC_LEGAL_ROUTES = ["/privacy", "/terms", "/delete-account"] as const;

export type PublicRoute = (typeof PUBLIC_ROUTES)[number];

export type PublicRouteSemantic = {
  title: string;
  description: string;
  schemaType: "WebPage" | "CollectionPage" | "ProfilePage";
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
    // `/` is dual-mode: anonymous visitors receive the intro surface, while
    // the authenticated canonical route is the Chat workspace.
    voicePlaybookId: "route.chat.root",
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
  "/manishhussh": {
    title: "Manish Sainani | Founder & CEO, Hussh",
    description:
      "Manish Sainani is the Founder & CEO of Hussh, building personal agent infrastructure people own: Hussh One and the open consent protocol PCHP.",
    schemaType: "ProfilePage",
    voicePlaybookId: "route.manishhussh",
  },
};

/**
 * Path prefixes that must never be indexed. Used by robots to disallow
 * authenticated product surfaces and machine endpoints.
 */
export const DISALLOWED_PREFIXES = [
  "/calendar/reschedule",
  "/api/",
  "/login",
  "/getting-started",
  "/agent",
  "/one",
  "/kai",
  "/ria",
  "/pkm",
  "/portfolio",
  "/profile",
  "/one/profile",
  "/consents",
  "/connected-systems",
  "/gmail",
  "/logout",
  "/register-phone",
  "/labs",
  // Public Wallet Profile pages are per-person contact details shared by link
  // and revocable at any time. Never indexed, never trained on.
  "/c",
  "/oauth",
  "/connect",
  "/wallet",
  "/people",
  "/circle",
] as const;

/** Build an absolute URL for a site-relative path. */
export function absoluteUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${SITE_URL}${suffix}`;
}

/** Public documents and blog entries only; private, API and per-person URLs fail closed. */
export function isIndexablePath(path: string): boolean {
  return (PUBLIC_ROUTES as readonly string[]).includes(path)
    || (PUBLIC_LEGAL_ROUTES as readonly string[]).includes(path)
    || path === "/welcome"
    || (path.startsWith("/blog/") && !path.startsWith("/blog/api/"));
}
