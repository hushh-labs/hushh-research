import {
  AppPageShell,
  AppPageHeaderRegion,
  AppPageContentRegion,
} from "@/components/app-ui/app-page-shell";

import { BookOpen } from "@/components/icons";
import { KnowledgeSectionHeader } from "@/components/app-ui/knowledge-section-header";
import { BlogPostList } from "@/components/research/blog-post-list";
import { BLOG_POSTS } from "@/lib/research/blog";

export function BlogIndex() {
  return (
    <AppPageShell width="agent" fitContent className="relative isolate">
      <AppPageHeaderRegion>
        <KnowledgeSectionHeader
          title="Notes on consent and control"
          description="Product and protocol thinking, written from the person’s point of view."
          icon={BookOpen}
          tone="purple"
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion className="mt-4 min-w-0 space-y-4">
        <BlogPostList posts={BLOG_POSTS} />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
