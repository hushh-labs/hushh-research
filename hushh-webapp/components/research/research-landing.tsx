import Link from "next/link";
import { BookOpen, FileText, ShieldCheck } from "lucide-react";
import {
  AppPageShell,
  AppPageHeaderRegion,
  AppPageContentRegion,
} from "@/components/app-ui/app-page-shell";
import { Hero, CardGrid, Card, Band, Figure } from "@/components/app-ui/sections";
import { ROUTES } from "@/lib/navigation/routes";
import { PCHP_SPEC_META } from "@/lib/research/pchp-spec";
import { BLOG_POSTS } from "@/lib/research/blog";
import { ResearchSubNav } from "@/components/research/research-sub-nav";
import { summerColorForKey } from "@/lib/research/summer-theme";
import { cn } from "@/lib/utils";

export function ResearchLanding() {
  const latestPosts = BLOG_POSTS.slice(0, 3);

  return (
    <AppPageShell width="reading" className="py-6 sm:py-10">
      <AppPageHeaderRegion>
        <div className="mb-5">
          <ResearchSubNav />
        </div>
        <Hero
          kicker="Research & Papers"
          title="Open protocols, given to the commons."
          lede="We publish our protocol work in the open and give it away. Our flagship is PCHP — the Personal Consent Handshake Protocol — an open standard for sharing personal data with consent and control built into every transaction."
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion className="mt-8 space-y-10">
        <CardGrid cols={2}>
          <Card
            href={ROUTES.RESEARCH_PROTOCOL}
            icon={<FileText className="h-5 w-5" />}
            title="PCHP Specification"
            body="The full protocol — six-phase handshake, token wire formats, scope grammar, zero-knowledge envelope, transparency log, conformance levels."
            cta="Read the spec"
          />
          <Card
            href={ROUTES.BLOG}
            icon={<BookOpen className="h-5 w-5" />}
            title="Blog"
            body="Why consent-first information sharing matters, what it unlocks, and how to adopt PCHP — written working backwards from the human."
            cta="Read the blog"
          />
        </CardGrid>

        <Figure>
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-300" />
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                PCHP {PCHP_SPEC_META.version} · {PCHP_SPEC_META.status}
              </h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Specification text under CC0 (public domain); schema and reference code
                under Apache-2.0. Learned from the best — MCP, LSP, SSH, OAuth, WebAuthn —
                and credited in full. Updated {PCHP_SPEC_META.updated}.
              </p>
            </div>
          </div>
        </Figure>

        <Band title="Latest writing">
          <ul className="mt-4 space-y-2.5">
            {latestPosts.map((post) => {
              const c = summerColorForKey(post.slug);
              return (
                <li key={post.slug}>
                  <Link
                    href={`${ROUTES.BLOG}/${post.slug}`}
                    className="group flex items-start gap-3 rounded-[var(--app-card-radius-feature)] border border-transparent px-2 py-2.5 transition-colors hover:border-border/60 hover:bg-muted/30 hover:px-4"
                  >
                    <span
                      className={cn("mt-2 h-2 w-2 shrink-0 rounded-full", c.dot)}
                    />
                    <span className="min-w-0">
                      <span
                        className={cn(
                          "block text-[15px] font-medium transition-opacity group-hover:opacity-80",
                          c.text
                        )}
                      >
                        {post.title}
                      </span>
                      <span className="mt-0.5 block text-sm leading-6 text-muted-foreground">
                        {post.excerpt}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Band>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
