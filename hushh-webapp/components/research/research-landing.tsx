import Link from "next/link";
import { BookOpenText, FileText, ArrowRight } from "lucide-react";
import {
  AppPageShell,
  AppPageHeaderRegion,
  AppPageContentRegion,
} from "@/components/app-ui/app-page-shell";
import { Band } from "@/components/app-ui/sections";
import { PageHeader } from "@/components/app-ui/page-sections";
import { ROUTES } from "@/lib/navigation/routes";
import { BLOG_POSTS } from "@/lib/research/blog";

export function ResearchLanding() {
  const latestPosts = BLOG_POSTS.slice(0, 2);

  return (
    <AppPageShell width="reading" className="pb-4 pt-0 sm:pb-6">
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="Research"
          title="Open consent protocol"
          description="Protocol notes, conformance, and the reasoning behind consented information exchange."
          descriptionFullWidth
          icon={BookOpenText}
          accent="research"
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion className="mt-5 space-y-6">
        <ul>
          <li>
            <Link
              href={ROUTES.RESEARCH_PROTOCOL}
              className="group flex min-h-0 w-full items-center gap-3 rounded-[var(--app-card-radius-standard)] border border-border/60 px-3 py-3 transition-colors hover:bg-muted/30 sm:px-4"
            >
              <div className="flex size-9 shrink-0 items-center justify-center rounded-[var(--app-card-radius-compact)] bg-blue-100/50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400">
                <FileText className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium text-foreground transition-opacity group-hover:opacity-80">
                  PCHP Specification
                </span>
                <span className="mt-0.5 block text-sm leading-5 text-muted-foreground">
                  Protocol, scopes, encryption, and conformance.
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1 text-sm font-medium text-muted-foreground">
                <span className="hidden sm:inline">Read</span>
                <ArrowRight className="size-4" />
              </div>
            </Link>
          </li>
        </ul>

        <Band title="Latest writing" className="space-y-1">
          <ul className="divide-y divide-border/60 rounded-[var(--app-card-radius-standard)] border border-border/60 px-3 sm:px-4">
            {latestPosts.map((post) => (
              <li key={post.slug}>
                <Link
                  href={`${ROUTES.BLOG}/${post.slug}`}
                  className="group flex min-h-11 items-center justify-between gap-4 py-2.5 text-[15px] font-medium text-foreground"
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
