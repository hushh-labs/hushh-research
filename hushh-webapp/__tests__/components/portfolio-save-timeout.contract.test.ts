import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return readFileSync(path.join(REPO, relativePath), "utf8");
}

describe("statement Save to Vault completion contract", () => {
  it("does not make source preference persistence hold the canonical save spinner", () => {
    const source = read("components/kai/views/portfolio-review-view.tsx");

    expect(source).toContain('"Updating portfolio source preference"');
    expect(source).toContain("void runKaiStepWithTimeout(");
    expect(source).not.toContain("await PlaidPortfolioService.setActiveSource");
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

    expect(source).toContain('"Refreshing portfolio after Plaid connection"');
    expect(source).not.toContain(".then(async () => {");
  });
});
