"use client";

import Link from "next/link";
import { CalendarDays } from "lucide-react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { ROUTES } from "@/lib/navigation/routes";
import type { BlogPost } from "@/lib/research/blog";
import { formatBlogDate } from "@/lib/research/format-blog-date";

/** Client boundary for the shared interactive list row and its local icon. */
export function BlogPostList({ posts }: { posts: readonly BlogPost[] }) {
  return (
    <SettingsGroup separatorInset testId="blog-post-list">
      {posts.map((post) => (
        <SettingsRow
          key={post.slug}
          asChild
          icon={CalendarDays}
          iconTone="blue"
          title={post.title}
          description={post.excerpt}
          trailing={
            <span className="hidden whitespace-nowrap text-right text-xs leading-5 text-muted-foreground sm:block">
              {formatBlogDate(post.date)}
              <br />
              {post.readingMinutes} min read
            </span>
          }
          chevron
          className="min-h-20"
          testId={`blog-post-${post.slug}`}
        >
          <Link href={`${ROUTES.BLOG}/${post.slug}`} />
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}
