import {
  AppPageShell,
  AppPageHeaderRegion,
  AppPageContentRegion,
} from "@/components/app-ui/app-page-shell";

import { BookOpen } from "lucide-react";
import { PageHeader } from "@/components/app-ui/page-sections";
import { BlogPostList } from "@/components/research/blog-post-list";
import { BLOG_POSTS } from "@/lib/research/blog";

export function BlogIndex() {
  return (
    <AppPageShell width="reading" className="pb-6 pt-0 sm:pb-10">
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="Blog"
          title="Notes on consent and control"
          description="Product and protocol thinking, written from the person’s point of view."
          descriptionFullWidth
          icon={BookOpen}
          accent="research"
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion className="mt-5">
        <BlogPostList posts={BLOG_POSTS} />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
