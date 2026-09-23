import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return readFileSync(path.join(REPO, relativePath), "utf8");
}

describe("statement Save to Vault completion contract", () => {
  it("keeps the source choice in the saved record, with no server call after the save", () => {
    const source = read("components/kai/views/portfolio-review-view.tsx");

    // The statement save itself records the active source; the server
    // preference table was removed with the server-held Plaid path.
    expect(source).toContain('active_source: "statement"');
    expect(source).not.toContain("PlaidPortfolioService");
    expect(source).not.toContain('"Updating portfolio source preference"');
  });

  it("bounds the sample brokerage template and native multipart fallback", () => {
    const demoTemplate = read("lib/services/demo-mode-template-service.ts");
    const apiService = read("lib/services/api-service.ts");

    expect(demoTemplate).toContain("fetchWithWebTimeout");
    expect(demoTemplate).toContain("DEMO_TEMPLATE_TIMEOUT_MS");
    expect(apiService).toContain("const formResponse = await fetchWithWebTimeout");
  });

  it("does not keep the dashboard Plaid flow open while refreshing projections", () => {
    const source = read("components/kai/views/dashboard-master-view.tsx");

    // Connect and relink run on the vault path; the refresh after either is
    // fired, never awaited inside the Link session.
    expect(source).toContain("relinkVaultPlaid(");
    expect(source).toContain("void reload();");
    expect(source).not.toContain(".then(async () => {");
  });
});
