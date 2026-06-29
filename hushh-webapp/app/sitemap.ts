import type { MetadataRoute } from "next";

import { absoluteUrl, PUBLIC_ROUTES } from "@/lib/seo/site";

/**
 * sitemap.xml
 *
 * Lists only the public, indexable routes from the SEO allow-list. The home
 * route is given the highest priority; entry/marketing surfaces follow.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return PUBLIC_ROUTES.map((route) => ({
    url: absoluteUrl(route),
    lastModified,
    changeFrequency: route === "/" ? "daily" : "weekly",
    priority: route === "/" ? 1 : 0.7,
  }));
}
