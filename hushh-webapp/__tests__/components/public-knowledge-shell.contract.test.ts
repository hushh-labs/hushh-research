import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("public knowledge shell contract", () => {
  it("uses the shared top shell instead of rendering route-local tabs", () => {
    const routes = read("lib/navigation/top-shell-tabs.ts");
    const workspace = read("components/app-ui/public-knowledge-workspace.tsx");
    const research = read("components/research/research-landing.tsx");
    const blog = read("components/research/blog-post-list.tsx");
    const developers = read("components/developers/developer-docs-hub.tsx");

    expect(routes).toContain(
      "return resolvePublicKnowledgeTopShellTabSet(routeKey);",
    );
    expect(workspace).toContain("<SwipeViews");
    expect(workspace).toContain("buildPublicKnowledgeRoute(next)");
    expect(research).not.toContain("PublicKnowledgeNav");
    expect(blog).not.toContain("PublicKnowledgeNav");
    expect(developers).not.toContain("PublicKnowledgeNav");
  });

  it("keeps copy control inside the developer code editor chrome", () => {
    const developers = read("components/developers/developer-docs-hub.tsx");

    expect(developers).toContain('data-slot="developer-code-editor"');
    expect(developers).toContain("aria-label={`Copy ${copyLabel}`}");
  });

  it("keeps research and blog browse rows in the shared list grammar", () => {
    const research = read("components/research/research-landing.tsx");
    const blog = read("components/research/blog-post-list.tsx");

    expect(research).not.toContain("PCHP_SPEC_META");
    expect(research).toContain("items-center");
    expect(research).toContain("<PageHeader");
    expect(research).toContain('accent="research"');
    expect(research).toContain("BLOG_POSTS.slice(0, 2)");
    expect(blog).toContain("<SettingsGroup separatorInset");
    expect(blog).toContain("<SettingsRow");
  });
});
