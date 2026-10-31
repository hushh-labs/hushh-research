import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { BLOG_POSTS } from "@/lib/research/blog";
import {
  absoluteUrl,
  DISALLOWED_PREFIXES,
  PUBLIC_ROUTES,
  PUBLIC_LEGAL_ROUTES,
  PUBLIC_CANONICAL_PATHS,
  canonicalSiteUrl,
  SITE_URL,
} from "@/lib/seo/site";

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production"));
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("seo: sitemap", () => {
  it("covers exactly the public allow-list routes and published posts", () => {
    const entries = sitemap();
    const urls = entries.map((e) => e.url).sort();
    const expected = [
      ...[...PUBLIC_ROUTES, ...PUBLIC_LEGAL_ROUTES].map((route) => absoluteUrl(PUBLIC_CANONICAL_PATHS[route] ?? route)),
      ...BLOG_POSTS.map((post) => absoluteUrl(`/blog/${post.slug}`)),
    ].sort();
    expect(urls).toEqual(expected);
  });

  it("gives the home route top priority", () => {
    const home = sitemap().find((e) => e.url === absoluteUrl("/"));
    expect(home?.priority).toBe(1);
  });

  it("emits only absolute URLs under the canonical origin", () => {
    for (const entry of sitemap()) {
      expect(entry.url.startsWith(`${SITE_URL}/`)).toBe(true);
    }
  });
});

describe("seo: robots", () => {
  it("disallows every authenticated product prefix for all crawlers", () => {
    const { rules } = robots();
    const ruleList = Array.isArray(rules) ? rules : [rules];
    for (const rule of ruleList) {
      const disallow = Array.isArray(rule.disallow)
        ? rule.disallow
        : rule.disallow
          ? [rule.disallow]
          : [];
      for (const prefix of DISALLOWED_PREFIXES) {
        expect(disallow).toContain(prefix);
      }
    }
  });

  it("explicitly allow-lists AI answer-engine crawlers", () => {
    const { rules } = robots();
    const ruleList = Array.isArray(rules) ? rules : [rules];
    const agents = ruleList.map((r) => r.userAgent).flat();
    expect(agents).toContain("GPTBot");
    expect(agents).toContain("ClaudeBot");
    expect(agents).toContain("PerplexityBot");
    expect(agents).toContain("Google-Extended");
  });

  it("points to the sitemap at the canonical origin", () => {
    const result = robots();
    expect(result.sitemap).toBe(`${SITE_URL}/sitemap.xml`);
  });
});


it.each(["dev", "uat", "", "unknown"])("excludes non-production %s builds, even under NODE_ENV production", (environment) => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", environment);
  expect(sitemap()).toEqual([]);
  expect(robots()).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
});

it("keeps the canonical app in its environment and refuses arbitrary authorities", () => {
  for (const prefix of ["one", "uat.one", "dev.one"]) {
    for (const domain of ["hushh.ai", "hussh.ai", "hussh.si"]) {
      expect(canonicalSiteUrl(`https://${prefix}.${domain}/ignored?x=1`)).toBe(`https://${prefix}.hussh.si`);
    }
  }
  for (const input of ["https://one.hussh.si.evil.test", "https://one.hussh.si@evil.test", "http://one.hussh.si", "bad"]) {
    expect(canonicalSiteUrl(input)).toBe("https://one.hussh.si");
  }
});

it("uses rendered public destinations and real publication dates", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01"));
  const first = sitemap();
  vi.setSystemTime(new Date("2031-01-01"));
  expect(sitemap()).toEqual(first);
  expect(first.map((entry) => new URL(entry.url).pathname + new URL(entry.url).search)).toContain("/welcome?tab=research");
  expect(first.map((entry) => new URL(entry.url).pathname)).not.toContain("/research");
  expect(first.map((entry) => new URL(entry.url).pathname)).not.toContain("/getting-started");
  const post = BLOG_POSTS[0]!;
  expect(first.find((entry) => entry.url.endsWith(`/blog/${post.slug}`))?.lastModified).toEqual(new Date(post.date));
  expect(first.find((entry) => entry.url === absoluteUrl("/"))?.lastModified).toBeUndefined();
});
