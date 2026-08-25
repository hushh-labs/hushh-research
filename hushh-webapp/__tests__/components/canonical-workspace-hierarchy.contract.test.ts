import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("canonical workspace hierarchy", () => {
  it("keeps nested Profile pages behind the stack-owned shared PageHeader", () => {
    const stack = read("components/profile/profile-stack-navigator.tsx");

    expect(stack).toContain("<PageHeader");
    expect(stack).toContain('data-profile-stack-content="true"');
    expect(stack).not.toContain("function StackHeader");
    expect(stack).not.toContain("<AppPageShell");
  });

  it("lets the shared top shell own the Consent Center title and tabs", () => {
    const consent = read("components/consent/consent-center-page.tsx");
    const topShellTabs = read("lib/navigation/top-shell-tabs.ts");

    expect(consent).toContain('<AppPageShell as="main" width="reading"');
    expect(consent).toContain("TOP_SHELL_TAB_REGISTRY.consent");
    expect(consent).not.toContain("<PageHeader");
    expect(topShellTabs).toContain('label: "Consent Center"');
    expect(topShellTabs).toContain('label: "Requests"');
    expect(topShellTabs).toContain('label: "Active"');
    expect(topShellTabs).toContain('label: "History"');
    expect(topShellTabs).toContain('label: "Connections"');
    expect(consent).not.toContain('title="Your decision"');
    expect(consent).not.toContain(
      "Shares a one-time copy; later changes are not included.",
    );
  });

  it("keeps every Finance swipe panel inside the Profile reading gutter", () => {
    const finance = read("components/kai/kai-market-hub-page.tsx");

    expect(finance).toContain('width="reading"');
    expect(finance).toContain('"relative !px-0"');
    expect(finance).toContain('panelInset="page"');
    expect(finance).not.toContain('style={{ "--one-gutter": "0px" }}');
  });
});
