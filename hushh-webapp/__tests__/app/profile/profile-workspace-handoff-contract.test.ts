import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

const profilePageSource = readFileSync(
  join(process.cwd(), "components/profile/profile-workspace-page.tsx"),
  "utf8",
);
const payoutsSource = readFileSync(
  join(process.cwd(), "components/consent/document-hashcoins.tsx"),
  "utf8",
);

describe("profile workspace duplication contract", () => {
  it("keeps One dashboard workspaces out of the Profile landing screen", () => {
    expect(profilePageSource).not.toContain(
      '<SettingsGroup title="Workspaces">',
    );
    expect(profilePageSource).not.toContain(
      "const openMyDataPanel = () => router.push(ROUTES.PKM);",
    );
    expect(profilePageSource).not.toContain(
      "const openAccessPanel = () => router.push(ROUTES.CONSENTS);",
    );
    expect(profilePageSource).not.toContain(
      "const openGmailPanel = () => router.push(ROUTES.GMAIL);",
    );
    expect(profilePageSource).toContain(
      '<SettingsGroup title="Your settings" separatorInset>',
    );
    expect(profilePageSource).not.toContain("myDataRootBadge");
    expect(profilePageSource).not.toContain("accessRootBadge");
    expect(profilePageSource).not.toContain("Data loaded partially");
    expect(profilePageSource).not.toContain("Access loaded partially");
    expect(profilePageSource).not.toContain(
      "Unlock to review sync and receipts.",
    );
    expect(profilePageSource).not.toContain("Unlock to review email requests.");
  });

  it("loads legacy workspace data only for legacy workspace panels", () => {
    expect(profilePageSource).toContain(
      "function profileRouteNeedsWorkspaceData",
    );
    expect(profilePageSource).toContain('return panel === "my-data";');
    expect(profilePageSource).toContain(
      'enabled: Boolean(user?.uid) && !authLoading && activePanel === "gmail"',
    );
  });

  it("makes document pricing and payouts reachable from Profile, including after vault creation", () => {
    const home = profilePageSource.split('const profileRootContent = (')[1]?.split('if (legacyProfileRedirectHref)')[0] ?? "";
    const memory = profilePageSource.split('const myDataContent = (')[1]?.split('const accessContent = (')[0] ?? "";
    expect(home).toMatch(/title="Payouts"[\s\S]*?onClick=\{\(\) => openVaultBackedPanel\("payouts"\)\}/);
    expect(home).toMatch(/title="Request pricing"[\s\S]*?onClick=\{\(\) => openVaultBackedPanel\("request-pricing"\)\}/);
    expect(memory).not.toContain("DocumentRequestPricingCard");
    expect(memory).not.toContain("DocumentPayoutAccountCard");
    expect(memory).not.toContain("DocumentBankPayoutStatusCard");
    expect(memory).not.toContain("DocumentHashcoinPayouts");
    expect(profilePageSource).toContain('activePanel === "payouts"');
    expect(profilePageSource).toContain('activePanel === "request-pricing"');
    expect(profilePageSource).toContain("<DocumentHashcoinPayouts />");
    expect(payoutsSource).toContain("<DocumentPayoutAccountCard handleReturn showHistory={false} />");
    expect(profilePageSource).toContain("<DocumentRequestPricingCard");
    expect(profilePageSource).toMatch(/if \(vaultAccess\.needsVaultCreation && panel !== "security"\) \{\s*setPendingProfileTarget\(\{ panel, detail, mode: "push" \}\);/);
    expect(profilePageSource).toMatch(/else if \(pendingProfileTarget\) \{\s*updateProfileView\(/);
    expect(profilePageSource).toMatch(/const handleVaultCreationOpenChange = \(open: boolean\) => \{[\s\S]*?else if \(!vaultCreationCompletingRef\.current\) \{\s*setPendingProfileTarget\(null\);/);
    expect(profilePageSource).toContain("onOpenChange={handleVaultCreationOpenChange}");
  });

  it("returns a saved request price only to a safe in-app origin", () => {
    const pricing = profilePageSource.split('activePanel === "request-pricing") {')[1]?.split("} else if (")[0] ?? "";
    // The only navigation target is the validated `from`; the pane's query belongs to its host.
    expect(pricing).toMatch(/const pricingReturnTo = isPanePresentation\s*\?\s*null\s*:\s*normalizeInternalRouteHref\(searchParams\.get\("from"\)\);/);
    expect(pricing).toMatch(/onSaved=\{pricingReturnTo \? \(\) => \{\s*toast\.success\("Price saved"\);\s*router\.replace\(pricingReturnTo\);\s*\} : undefined\}/);
    expect(pricing.match(/router\.(?:push|replace)\(/g)).toEqual(["router.replace("]);
    // Negative control: an external or protocol-relative origin yields no handler, so the card confirms inline.
    expect(normalizeInternalRouteHref("/one/feed")).toBe("/one/feed");
    expect(normalizeInternalRouteHref("https://evil.example/one/feed")).toBeNull();
    expect(normalizeInternalRouteHref("//evil.example/one/feed")).toBeNull();
  });

  it("keeps Security as the sole Profile entry for vault controls", () => {
    expect(profilePageSource).not.toContain('className="min-w-[148px]"');
    expect(profilePageSource).not.toContain('voiceControlId="profile_vault"');
    expect(profilePageSource).not.toContain("const openVaultSettingsRow");
    expect(profilePageSource).toContain('voiceControlId="profile_security"');
    expect(profilePageSource).toContain(
      'voiceActionId="route.profile_security_panel"',
    );
    expect(profilePageSource).not.toContain(
      'voiceActionId="route.profile_security"',
    );
  });
});
