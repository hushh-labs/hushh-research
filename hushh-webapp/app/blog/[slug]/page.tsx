import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BlogPostView } from "@/components/research/blog-post-view";
import { BLOG_POSTS, getBlogPost } from "@/lib/research/blog";

export function generateStaticParams() {
  return BLOG_POSTS.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getBlogPost(slug);
  if (!post) {
    return { title: "Post not found · Hushh Research" };
  }
  return {
    title: `${post.title} · Hushh Research`,
    description: post.excerpt,
  };
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = getBlogPost(slug);
  if (!post) {
    notFound();
  }
  return <BlogPostView post={post} />;
}
