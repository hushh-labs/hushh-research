import Link from "next/link";
import { ArrowRight, BookOpen, FileText, ShieldCheck, Sparkles } from "lucide-react";
import {
  AppPageShell,
  AppPageHeaderRegion,
  AppPageContentRegion,
} from "@/components/app-ui/app-page-shell";
import { ROUTES } from "@/lib/navigation/routes";
import { PCHP_SPEC_META } from "@/lib/research/pchp-spec";
import { BLOG_POSTS } from "@/lib/research/blog";
import { ResearchSubNav } from "@/components/research/research-sub-nav";
import {
  SUMMER_HERO_WASH,
  SUMMER_PALETTE,
  summerColorForKey,
} from "@/lib/research/summer-theme";
import { cn } from "@/lib/utils";

export function ResearchLanding() {
  const latestPosts = BLOG_POSTS.slice(0, 3);
  const specColor = SUMMER_PALETTE[0]!; // sky
  const blogColor = SUMMER_PALETTE[3]!; // fuchsia

  return (
    <AppPageShell width="reading" className="py-6 sm:py-10">
      <AppPageHeaderRegion>
        <div className="mb-5">
          <ResearchSubNav />
        </div>
        <div className="relative overflow-hidden rounded-[var(--app-card-radius-feature)] border border-border/60 px-5 py-7 sm:px-8 sm:py-10">
          <div className={SUMMER_HERO_WASH} />
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-sky-700 dark:text-sky-300">
            <Sparkles className="h-4 w-4" />
            Research &amp; Papers
          </div>
          <h1 className="mt-3 max-w-2xl bg-gradient-to-r from-sky-600 via-fuchsia-600 to-orange-500 bg-clip-text text-[30px] font-semibold leading-[1.08] tracking-tight text-transparent sm:text-[40px] dark:from-sky-300 dark:via-fuchsia-300 dark:to-amber-300">
            Open protocols, given to the commons.
          </h1>
          <p className="mt-3 max-w-xl text-[15px] leading-7 text-foreground/80">
            We publish our protocol work in the open and give it away. Our flagship is
            PCHP — the Personal Consent Handshake Protocol — an open standard for sharing
            personal data with consent and control built into every transaction.
          </p>
        </div>
      </AppPageHeaderRegion>

      <AppPageContentRegion className="mt-8 space-y-10">
        <section className="grid gap-4 sm:grid-cols-2">
          <ColorCard
            href={ROUTES.RESEARCH_PROTOCOL}
            colorName={specColor.name}
            icon={<FileText className="h-5 w-5" />}
            title="PCHP Specification"
            body="The full protocol — six-phase handshake, token wire formats, scope grammar, zero-knowledge envelope, transparency log, conformance levels."
            cta="Read the spec"
          />
          <ColorCard
            href={ROUTES.BLOG}
            colorName={blogColor.name}
            icon={<BookOpen className="h-5 w-5" />}
            title="Blog"
            body="Why consent-first data sharing matters, what it unlocks, and how to adopt PCHP — written working backwards from the human."
            cta="Read the blog"
          />
        </section>

        <section className="relative overflow-hidden rounded-[var(--app-card-radius-feature)] border border-border/60 p-5">
          <div className={SUMMER_HERO_WASH} />
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
        </section>

        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-foreground">Latest writing</h2>
          <ul className="space-y-2.5">
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
        </section>
      </AppPageContentRegion>
    </AppPageShell>
  );
}

function ColorCard({
  href,
  colorName,
  icon,
  title,
  body,
  cta,
}: {
  href: string;
  colorName: string;
  icon: React.ReactNode;
  title: string;
  body: string;
  cta: string;
}) {
  const color =
    SUMMER_PALETTE.find((c) => c.name === colorName) ?? SUMMER_PALETTE[0]!;
  return (
    <Link
      href={href}
      className={cn(
        "group flex flex-col rounded-[var(--app-card-radius-feature)] border bg-card p-5 transition-all hover:-translate-y-0.5",
        "border-border/60 hover:shadow-lg",
        color.border
      )}
    >
      <div
        className={cn(
          "mb-3 flex w-11 items-center justify-center rounded-[var(--app-card-radius-feature)] p-2.5",
          color.iconTile
        )}
      >
        {icon}
      </div>
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <p className="mt-1.5 flex-1 text-sm leading-6 text-muted-foreground">{body}</p>
      <span
        className={cn(
          "mt-4 inline-flex items-center gap-1.5 text-sm font-medium",
          color.text
        )}
      >
        {cta}
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}
