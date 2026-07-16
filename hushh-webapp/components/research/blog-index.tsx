import Link from "next/link";
import {
  AppPageShell,
  AppPageHeaderRegion,
  AppPageContentRegion,
} from "@/components/app-ui/app-page-shell";
import { Hero } from "@/components/app-ui/sections";
import { PublicKnowledgeNav } from "@/components/app-ui/public-knowledge-nav";
import { ROUTES } from "@/lib/navigation/routes";
import { BLOG_POSTS } from "@/lib/research/blog";
import { formatBlogDate } from "@/lib/research/format-blog-date";

export function BlogIndex() {
  return (
    <AppPageShell width="reading" className="pb-6 pt-0 sm:pb-10">
      <AppPageHeaderRegion>
        <div className="mb-5">
          <PublicKnowledgeNav />
        </div>
        <Hero
          kicker="Blog"
          title="On consent, control, and the human"
          lede="Working backwards from the person and the job they are trying to get done."
        />
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
