import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function readMarketplacePage() {
  return fs.readFileSync(path.join(root, "app", "marketplace", "page.tsx"), "utf8");
}

describe("marketplace client card layout contract", () => {
  it("keeps swipe cards content-sized instead of stretching CTAs away from the profile details", () => {
    const source = readMarketplacePage();

    expect(source).toContain('data-testid="marketplace-swipe-card"');
    expect(source).toContain("relative mx-auto flex w-full max-w-[1120px] items-center justify-center");
    expect(source).toContain("flex w-full touch-pan-y flex-col gap-6");
    expect(source).toContain("p-6 shadow-[var(--app-card-shadow-feature)]");
    expect(source).toContain("space-y-6");
    expect(source).toContain("flex items-center gap-5");
    expect(source).toContain("rounded-[var(--radius-md)] bg-background/50 p-5");
    expect(source).toContain('data-testid="marketplace-swipe-card-actions"');
    expect(source).toContain("grid grid-cols-3 gap-3");
    expect(source).not.toContain("max-w-[720px]");
    expect(source).not.toContain("max-w-none");
    expect(source).not.toContain('minHeight: "min(60dvh, 560px)"');
    expect(source).not.toContain("flex w-full touch-pan-y flex-col justify-between");
  });

  it("keeps marketplace card CTAs aligned without enlarging the card container", () => {
    const source = readMarketplacePage();

    expect(source).toContain('data-testid="marketplace-client-card-grid"');
    expect(source).toContain("grid gap-4 pb-16 md:auto-rows-fr md:grid-cols-2 md:items-stretch xl:grid-cols-3");
    expect(source).toContain('data-testid="marketplace-client-card"');
    expect(source).toContain(
      "h-full min-h-[286px] rounded-[28px] p-4 sm:p-5 [&>div]:h-full [&>div]:min-h-0"
    );
    expect(source).toContain("flex h-full min-h-0 flex-col gap-4");
    expect(source).not.toContain("min-h-[320px]");
    expect(source).not.toContain("height: 420px");
    expect(source).not.toContain("position: absolute");

    expect(source).toContain('data-testid="marketplace-client-card-header"');
    expect(source).toContain("flex min-h-[72px] items-start gap-4");
    expect(source).toContain('data-testid="marketplace-client-card-body"');
    expect(source).toContain("flex min-h-0 flex-1 flex-col");
    expect(source).toContain('data-testid="marketplace-client-card-meta"');
    expect(source).toContain("mt-auto min-h-[18px] pt-3");
    expect(source).toContain('data-testid="marketplace-client-card-actions"');
    expect(source).toContain("mt-auto grid grid-cols-1 gap-2 pt-1 sm:grid-cols-2");
  });

  it("wires the toolbar refresh beside Contacts to contact matching", () => {
    const source = readMarketplacePage();

    expect(source).toContain('aria-label="Refresh contacts"');
    expect(source).toContain("onClick={() => void matchContacts()}");
    expect(source).toContain("aria-busy={contactMatchLoading}");
    expect(source).not.toContain('aria-label={directoryKind === "investors" ? "Refresh deck" : "Restart deck"}');
  });

  it("renders marketplace SEC evidence links with normalized labels", () => {
    const source = readMarketplacePage();

    expect(source).toContain("marketplaceInvestorEvidenceLinks(selectedInvestorEvidence)");
    expect(source).toContain("key={source.id}");
    expect(source).toContain("href={source.url}");
    expect(source).toContain("{source.label}");
    expect(source).toContain("aria-label={`${source.label} opens in a new tab`}");
    expect(source).not.toContain("SEC source");
  });

  it("surfaces database-backed saved investor leads in the RIA deck", () => {
    const source = readMarketplacePage();

    expect(source).toContain('data-testid="marketplace-saved-leads"');
    expect(source).toContain("Saved investor leads");
    expect(source).toContain('item.status === "shortlisted"');
    expect(source).toContain("marketplaceSavedInvestorLeadsFromActions(actions)");
    expect(source).toContain("setSavedInvestorLeads(savedLeads)");
    expect(source).toContain("removeSavedInvestorLead");
    expect(source).toContain('"pass", { gesture: "remove_saved_lead" }');
    expect(source).toContain('toast.success("Saved lead removed from the RIA deck.")');
    expect(source).not.toContain("localStorage.setItem(key, JSON.stringify([...savedInvestorLeads");
  });
});
