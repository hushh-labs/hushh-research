import type { MetadataRoute } from "next";

import { DISALLOWED_PREFIXES, SITE_URL } from "@/lib/seo/site";

/**
 * robots.txt
 *
 * Allows general crawlers and AI answer engines to index the public marketing
 * and entry surfaces, while disallowing authenticated product paths and the
 * API. AI crawlers are explicitly allow-listed so Hussh can be surfaced in
 * answer-engine results (AEO).
 */
export default function robots(): MetadataRoute.Robots {
  const disallow = DISALLOWED_PREFIXES.map((prefix) => prefix);

  // AI answer-engine crawlers we explicitly welcome for AEO.
  const aiCrawlers = [
    "GPTBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    "ClaudeBot",
    "Claude-Web",
    "anthropic-ai",
    "PerplexityBot",
    "Perplexity-User",
    "Google-Extended",
    "Applebot-Extended",
    "CCBot",
  ];

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow,
      },
      ...aiCrawlers.map((userAgent) => ({
        userAgent,
        allow: "/",
        disallow,
      })),
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
