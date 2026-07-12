import Link from "next/link";
import { BookOpen } from "lucide-react";
import {
  AppPageShell,
  AppPageHeaderRegion,
  AppPageContentRegion,
} from "@/components/app-ui/app-page-shell";
import { ResearchSubNav } from "@/components/research/research-sub-nav";
import { ROUTES } from "@/lib/navigation/routes";
import { BLOG_POSTS } from "@/lib/research/blog";
import { formatBlogDate } from "@/lib/research/format-blog-date";
import {
  SUMMER_HERO_WASH,
  summerColorForKey,
} from "@/lib/research/summer-theme";
import { cn } from "@/lib/utils";

export function BlogIndex() {
  return (
    <AppPageShell width="reading" className="py-6 sm:py-10">
      <AppPageHeaderRegion>
        <div className="mb-5">
          <ResearchSubNav />
        </div>
        <div className="relative overflow-hidden rounded-[var(--app-card-radius-feature)] border border-border/60 px-5 py-7 sm:px-8 sm:py-9">
          <div className={SUMMER_HERO_WASH} />
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-fuchsia-700 dark:text-fuchsia-300">
            <BookOpen className="h-4 w-4" />
            Blog
          </div>
          <h1 className="mt-3 max-w-2xl bg-gradient-to-r from-fuchsia-600 via-violet-600 to-sky-500 bg-clip-text text-[28px] font-semibold leading-[1.1] tracking-tight text-transparent sm:text-[36px] dark:from-fuchsia-300 dark:via-violet-300 dark:to-sky-300">
            On consent, control, and the human
          </h1>
          <p className="mt-2.5 max-w-xl text-[15px] leading-7 text-foreground/80">
            Working backwards from the person and the job they are trying to get done.
          </p>
        </div>
      </AppPageHeaderRegion>

      <AppPageContentRegion className="mt-8">
        <ul className="divide-y divide-border/60">
          {BLOG_POSTS.map((post) => (
            <li key={post.slug} className="py-6 first:pt-0">
              <Link href={`${ROUTES.BLOG}/${post.slug}`} className="group block">
                <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <time dateTime={post.date}>{formatBlogDate(post.date)}</time>
                  <span aria-hidden>·</span>
                  <span>{post.readingMinutes} min read</span>
                  {post.tags.slice(0, 2).map((tag) => {
                    const c = summerColorForKey(tag);
                    return (
                      <span
                        key={tag}
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[11px] font-medium",
                          c.softBg,
                          c.text
                        )}
                      >
                        {tag}
                      </span>
                    );
                  })}
                </div>
                <h2 className="text-xl font-medium tracking-tight text-foreground transition-colors group-hover:text-sky-700 dark:group-hover:text-sky-300">
                  {post.title}
                </h2>
                <p className="mt-1.5 text-[15px] leading-7 text-muted-foreground">
                  {post.excerpt}
                </p>
                <p className="mt-2 text-xs text-muted-foreground/80">By {post.author}</p>
              </Link>
            </li>
          ))}
        </ul>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
