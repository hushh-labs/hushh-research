import Link from "next/link";
import { BookOpen, FileText, ShieldCheck, ArrowRight } from "lucide-react";
import {
  AppPageShell,
  AppPageHeaderRegion,
  AppPageContentRegion,
} from "@/components/app-ui/app-page-shell";
import { Hero, Band, Figure } from "@/components/app-ui/sections";
import { PublicKnowledgeNav } from "@/components/app-ui/public-knowledge-nav";
import { ROUTES } from "@/lib/navigation/routes";
import { PCHP_SPEC_META } from "@/lib/research/pchp-spec";
import { BLOG_POSTS } from "@/lib/research/blog";

export function ResearchLanding() {
  const latestPosts = BLOG_POSTS.slice(0, 3);

  return (
    <AppPageShell width="reading" className="pb-6 pt-0 sm:pb-10">
      <AppPageHeaderRegion>
        <div className="mb-5">
          <PublicKnowledgeNav />
        </div>
        <Hero
          kicker="Research"
          title="Open protocols, built for everyone."
          lede="PCHP is an open consent protocol for sharing information without giving up control."
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion className="mt-8 space-y-9">
        <ul className="space-y-3">
          <li>
            <Link
              href={ROUTES.RESEARCH_PROTOCOL}
              className="group flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4 rounded-[var(--app-card-radius-feature)] border border-transparent px-3 py-3 sm:px-4 sm:py-4 transition-colors hover:border-border/60 hover:bg-muted/30"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100/50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400">
                <FileText className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <span className="flex items-center text-[15px] font-medium text-foreground transition-opacity group-hover:opacity-80">
                  PCHP Specification
                </span>
                <span className="mt-1 block pl-0 text-sm leading-6 text-muted-foreground mr-4">
                  Handshake, wire formats, scope grammar, encryption, and conformance.
                </span>
              </div>
              <div className="hidden sm:flex shrink-0 pt-1 text-muted-foreground items-center gap-1">
                <span className="text-sm font-medium">Read the spec</span>
                <ArrowRight className="h-4 w-4" />
              </div>
            </Link>
          </li>
          <li>
            <Link
              href={ROUTES.BLOG}
              className="group flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4 rounded-[var(--app-card-radius-feature)] border border-transparent px-3 py-3 sm:px-4 sm:py-4 transition-colors hover:border-border/60 hover:bg-muted/30"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-100/50 dark:bg-violet-900/20 text-violet-600 dark:text-violet-400">
                <BookOpen className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <span className="flex items-center text-[15px] font-medium text-foreground transition-opacity group-hover:opacity-80">
                  Blog
                </span>
                <span className="mt-1 block pl-0 text-sm leading-6 text-muted-foreground mr-4">
                  Notes on consent, control, and building from the person outward.
                </span>
              </div>
              <div className="hidden sm:flex shrink-0 pt-1 text-muted-foreground items-center gap-1">
                <span className="text-sm font-medium">Read the blog</span>
                <ArrowRight className="h-4 w-4" />
              </div>
            </Link>
          </li>
        </ul>

        <Figure>
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-300" />
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                PCHP {PCHP_SPEC_META.version} · {PCHP_SPEC_META.status}
              </h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                CC0 specification · Apache-2.0 schema and reference code · Updated {PCHP_SPEC_META.updated}.
              </p>
            </div>
          </div>
        </Figure>

        <Band title="Latest writing">
          <ul className="mt-3 divide-y divide-border/60">
            {latestPosts.map((post) => (
              <li key={post.slug}>
                <Link
                  href={`${ROUTES.BLOG}/${post.slug}`}
                  className="group flex min-h-12 items-center justify-between gap-4 py-3 text-[15px] font-medium text-foreground"
                >
                  <span>{post.title}</span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </Link>
              </li>
            ))}
          </ul>
        </Band>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
