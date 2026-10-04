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

  it("places the Consent Center title and tabs below the shared back bar", () => {
    const consent = read("components/consent/consent-center-page.tsx");
    const topShellTabs = read("lib/navigation/top-shell-tabs.ts");

    expect(consent).toContain('<AppPageShell as="main" width="agent"');
    expect(consent).toContain("TOP_SHELL_TAB_REGISTRY.consent");
    expect(consent).toContain('<PageHeader title="Consent Center" titleRole="agent" />');
    expect(consent).toContain("<TopShellTabs tabSet={consentTabSet} />");
    expect(topShellTabs).not.toContain("if (pathname === ROUTES.CONSENTS)");
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

  it("matches Finance's header and tabs to the Location agent column", () => {
    const finance = read("components/kai/kai-market-hub-page.tsx");

    expect(finance).toContain('width="agent"');
    expect(finance).toContain('className="relative"');
    expect(finance).toContain('title="Finance"');
    expect(finance).toContain('titleRole="agent"');
    expect(finance).toContain(
      'className="ms-[var(--page-inline-gutter-standard)]"',
    );
    expect(finance).toContain("<TopShellTabs");
    expect(finance).toContain('panelInset="none"');
    expect(finance).not.toContain('style={{ "--one-gutter": "0px" }}');
  });

  it("keeps Finance bottom chrome clearance owned by the shared scroll root", () => {
    const finance = read("components/kai/kai-market-hub-page.tsx");
    const tabs = read("components/app-ui/top-shell-tabs.tsx");

    expect(finance).toContain('data-finance-workspace="true"');
    expect(finance).toContain('heightMode="active"');
    expect(finance).toContain("holdHeightDuringTransition={false}");
    expect(finance).toContain('viewportMinHeight="fill"');
    expect(finance).toContain("scrollAppToTop();");
    expect(finance).toContain("resetKaiBottomChromeVisibility();");
    expect(finance).not.toContain("router.replace(destination.href, { scroll: false })");
    expect(tabs).toContain('const shouldResetScrollOnSelection = tabSet.id === "finance";');
    expect(tabs).toContain("scrollAppToTop();");
    expect(tabs).toContain("resetKaiBottomChromeVisibility();");
    expect(tabs).toContain(
      "shouldResetScrollOnSelection ? undefined : { scroll: false }",
    );
    expect(finance).not.toContain('className="h-full w-full"');
    expect(finance).not.toContain("pb-32");
    expect(finance).not.toContain("pb-24");
    expect(finance).not.toContain("pb-20");
    expect(finance).not.toContain("--app-scroll-bottom-pad");
    expect(finance).not.toContain("--bottom-chrome-stack-height");
  });

  it("keeps Finance Portfolio and Analysis from adding route-local bottom reserves", () => {
    const portfolio = [
      read("components/kai/kai-flow.tsx"),
      read("components/kai/views/dashboard-master-view.tsx"),
    ].join("\n");
    const analysis = [
      read("app/one/kai/analysis/page.tsx"),
      read("components/kai/views/analysis-summary-view.tsx"),
      read("components/kai/views/history-detail-view.tsx"),
      read("components/kai/views/analysis-history-dashboard.tsx"),
    ].join("\n");

    expect(portfolio).not.toContain("pb-6");
    expect(portfolio).not.toContain("h-full overflow-hidden");
    expect(analysis).not.toContain("pb-safe");
    expect(analysis).not.toContain("h-full overflow-hidden");
    expect(analysis).not.toContain("space-y-6 overflow-hidden");
  });
});
