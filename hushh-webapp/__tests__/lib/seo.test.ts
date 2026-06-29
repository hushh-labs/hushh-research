import { describe, expect, it } from "vitest";

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import {
  absoluteUrl,
  DISALLOWED_PREFIXES,
  PUBLIC_ROUTES,
  SITE_URL,
} from "@/lib/seo/site";

describe("seo: sitemap", () => {
  it("covers exactly the public allow-list routes", () => {
    const entries = sitemap();
    const urls = entries.map((e) => e.url).sort();
    const expected = PUBLIC_ROUTES.map((r) => absoluteUrl(r)).sort();
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
