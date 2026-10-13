import type { MetadataRoute } from "next";

import { absoluteUrl, PUBLIC_ROUTES, PUBLIC_LEGAL_ROUTES, PUBLIC_CANONICAL_PATHS, isProductionIndexing } from "@/lib/seo/site";
import { BLOG_POSTS } from "@/lib/research/blog";

/**
 * sitemap.xml
 *
 * Lists only the public, indexable routes from the SEO allow-list. The home
 * route is given the highest priority; entry/marketing surfaces follow.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  if (!isProductionIndexing()) return [];

  return [
    ...[...PUBLIC_ROUTES, ...PUBLIC_LEGAL_ROUTES].map((route) => ({
      url: absoluteUrl(PUBLIC_CANONICAL_PATHS[route] ?? route),
      changeFrequency: route === "/" ? "daily" : "weekly",
      priority: route === "/" ? 1 : 0.7,
    } as const)),
    ...BLOG_POSTS.map((post) => ({
      url: absoluteUrl(`/blog/${post.slug}`),
      lastModified: new Date(post.date),
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ];
}
