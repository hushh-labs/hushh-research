import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import {
  AppPageShell,
  AppPageHeaderRegion,
  AppPageContentRegion,
} from "@/components/app-ui/app-page-shell";
import { Figure } from "@/components/app-ui/sections";
import { ProseMarkdown } from "@/components/research/prose-markdown";
import { ROUTES } from "@/lib/navigation/routes";
import type { BlogPost } from "@/lib/research/blog";
import { formatBlogDate } from "@/lib/research/format-blog-date";
import { summerColorForKey } from "@/lib/research/summer-theme";
import { cn } from "@/lib/utils";

export function BlogPostView({ post }: { post: BlogPost }) {
  return (
    <AppPageShell width="reading" className="py-6 sm:py-10">
      <AppPageHeaderRegion>
        <Link
          href={ROUTES.BLOG}
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-sky-700 dark:hover:text-sky-300"
        >
          <ArrowLeft className="h-4 w-4" />
          All posts
        </Link>

        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <time dateTime={post.date}>{formatBlogDate(post.date)}</time>
          <span aria-hidden>·</span>
          <span>{post.readingMinutes} min read</span>
          {post.tags.map((tag) => {
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

        <h1 className="bg-gradient-to-r from-sky-600 via-fuchsia-600 to-orange-500 bg-clip-text text-[30px] font-semibold leading-[1.12] tracking-tight text-transparent sm:text-[36px] dark:from-sky-300 dark:via-fuchsia-300 dark:to-amber-300">
          {post.title}
        </h1>
        <p className="mt-3 text-lg leading-8 text-muted-foreground">{post.subtitle}</p>
        <p className="mt-4 border-b border-border/60 pb-6 text-sm text-muted-foreground">
          By <span className="font-medium text-foreground">{post.author}</span>
        </p>
      </AppPageHeaderRegion>

      <AppPageContentRegion className="mt-8">
        <ProseMarkdown>{post.body}</ProseMarkdown>

        <Figure className="mt-12">
          <p className="text-sm leading-6 text-muted-foreground">
            PCHP is an open standard, donated to the commons.{" "}
            <Link
              href={ROUTES.RESEARCH_PROTOCOL}
              className="font-medium text-sky-700 underline decoration-sky-400/40 underline-offset-2 dark:text-sky-300"
            >
              Read the specification
            </Link>{" "}
            or{" "}
            <Link
              href={ROUTES.BLOG}
              className="font-medium text-sky-700 underline decoration-sky-400/40 underline-offset-2 dark:text-sky-300"
            >
              browse more writing
            </Link>
            .
          </p>
        </Figure>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
