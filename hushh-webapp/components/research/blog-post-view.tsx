import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import {
  AppPageShell,
  AppPageHeaderRegion,
  AppPageContentRegion,
} from "@/components/app-ui/app-page-shell";
import { Figure } from "@/components/app-ui/sections";
import { PublicKnowledgeNav } from "@/components/app-ui/public-knowledge-nav";
import { ProseMarkdown } from "@/components/research/prose-markdown";
import { ROUTES } from "@/lib/navigation/routes";
import type { BlogPost } from "@/lib/research/blog";
import { formatBlogDate } from "@/lib/research/format-blog-date";

export function BlogPostView({ post }: { post: BlogPost }) {
  return (
    <AppPageShell width="reading" className="pb-6 pt-0 sm:pb-10">
      <AppPageHeaderRegion>
        <div className="mb-5">
          <PublicKnowledgeNav />
        </div>
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
        </div>

        <h1 className="text-[30px] font-semibold leading-[1.12] tracking-tight text-foreground sm:text-[36px]">
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
