import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { isPkmDeveloperHost } from "@/app/one/pkm/developer-visibility";

describe("isPkmDeveloperHost", () => {
  it.each(["localhost", "LOCALHOST", "127.0.0.1", "::1", "[::1]"])(
    "allows the loopback host %s",
    (hostname) => {
      expect(isPkmDeveloperHost(hostname)).toBe(true);
    }
  );

  it.each(["uat.one.hushh.ai", "one.hushh.ai", "localhost.example.com", "10.0.0.12"])(
    "keeps developer tools hidden on %s",
    (hostname) => {
      expect(isPkmDeveloperHost(hostname)).toBe(false);
    }
  );

  it("keeps the product Memory route independent of developer explorer code", () => {
    const source = readFileSync(join(process.cwd(), "app/one/pkm/page.tsx"), "utf8");

    expect(source).not.toContain("PkmExplorerPanel");
    expect(source).not.toContain("pkm-explorer-panel");
  });

  it("loads the lab client only in a development build and then checks loopback host", () => {
    const route = readFileSync(
      join(process.cwd(), "app/profile/pkm-agent-lab/page.tsx"),
      "utf8"
    );
    const localGate = readFileSync(
      join(process.cwd(), "app/profile/pkm-agent-lab/local-page-client.tsx"),
      "utf8"
    );

    expect(route).not.toMatch(/import\s+PkmAgentLabPageClient/);
    expect(route).toContain('process.env.NODE_ENV === "development"');
    expect(route).toContain('dynamic(() => import("./local-page-client"))');
    expect(localGate).toContain("isPkmDeveloperHost(window.location.hostname)");
  });
});
