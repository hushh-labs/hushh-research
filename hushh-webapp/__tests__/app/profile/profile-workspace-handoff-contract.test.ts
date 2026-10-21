import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";
import { profileMenuGroups } from "@/components/profile/profile-menu-model";

const paymentsSource = readFileSync(join(process.cwd(), "components/consent/payments-and-earnings.tsx"), "utf8");

const profilePageSource = readFileSync(
  join(process.cwd(), "components/profile/profile-workspace-page.tsx"),
  "utf8",
);
const payoutsSource = readFileSync(
  join(process.cwd(), "components/consent/document-hashcoins.tsx"),
  "utf8",
);

/** Every mounted bank control that turns on Stripe-return handling, one entry per mount. */
function returnHandlingBankControls(): string[] {
  const mounts: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") visit(path);
      } else if (path.endsWith(".tsx")) {
        // A bare (or {true}) handleReturn; forwarding a prop is not a second mount.
        const source = readFileSync(join(process.cwd(), path), "utf8");
        for (const _ of source.matchAll(/<(?:PayoutBankRows|DocumentPayoutAccountCard)\b[^>]*?\shandleReturn(?=[\s/>]|=\{true\})/g)) mounts.push(path);
      }
    }
  };
  visit("components");
  visit("app");
  return mounts;
}

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
    expect(profileMenuGroups(true).flatMap(group => group.entries)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "payouts", label: "Payouts", voiceControlId: "profile_payouts", voiceActionId: "route.profile_payouts" }),
      expect.objectContaining({ id: "request-pricing", label: "Request pricing", voiceControlId: "profile_request_pricing", voiceActionId: "route.profile_request_pricing" }),
    ]));
    const actions = profilePageSource.split("const menuActions")[1]?.split("const profileRootContent")[0] ?? "";
    expect(actions).toContain('payouts: () => openVaultBackedPanel("payouts")');
    expect(actions).toContain('"request-pricing": () => openVaultBackedPanel("request-pricing")');
    expect(home).toContain("onClick={() => { void menuActions[entry.id](); }}");
    expect(memory).not.toContain("DocumentRequestPricingCard");
    expect(memory).not.toContain("DocumentPayoutAccountCard");
    expect(memory).not.toContain("DocumentBankPayoutStatusCard");
    expect(memory).not.toContain("DocumentHashcoinPayouts");
    expect(profilePageSource).toContain('activePanel === "payouts"');
    expect(profilePageSource).toContain('activePanel === "request-pricing"');
    expect(profilePageSource).toContain("<PaymentsAndEarnings key={user?.uid} />");
    // One bank control on Payouts: the bank rows in "Your money", the only
    // control that takes Stripe's return. A second would start setup again.
    const payoutsPanel = profilePageSource.split('activePanel === "payouts") {')[1]?.split("} else if (")[0] ?? "";
    expect(payoutsPanel).toContain("<PaymentsAndEarnings key={user?.uid} />");
    expect(payoutsPanel).not.toContain("AnswerPayoutAccount");
    expect(paymentsSource).toContain("<ScopeCommerceAccountPanel />");
    expect(paymentsSource.match(/<DocumentHashcoinPayouts\b/g)).toEqual(["<DocumentHashcoinPayouts"]);
    expect(paymentsSource).toMatch(/arrival\?\.source === "answers" \? <section[^>]*><AnswerPayoutAccount \/><\/section> : null/);
    expect(payoutsSource.match(/<(?:PayoutBankRows|DocumentPayoutAccountCard)\b/g)).toEqual(["<PayoutBankRows"]);
    expect(payoutsSource).toContain("<PayoutBankRows handleReturn onAccountChange={setBank} actionsRef={bankActions} />");
    expect(returnHandlingBankControls()).toEqual(["components/consent/document-hashcoins.tsx"]);
    // Search reads the redeem controls' literal ids where Payouts mounts them.
    expect(payoutsSource).toContain('data-voice-control-id="profile_payouts_redeem"');
    expect(payoutsSource).toContain('data-voice-control-id="profile_payouts_test_redeem"');
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
    expect(pricing).toMatch(/onSaved=\{\s*pricingReturnTo\s*\? \(\) => \{\s*toast\.success\("Price saved"\);\s*router\.replace\(pricingReturnTo\);\s*\}\s*:\s*undefined\s*\}/);
    expect(pricing.match(/router\.(?:push|replace)\(/g)).toEqual(["router.replace("]);
    // Negative control: an external or protocol-relative origin yields no handler, so the card confirms inline.
    expect(normalizeInternalRouteHref("/one/feed")).toBe("/one/feed");
    expect(normalizeInternalRouteHref("https://evil.example/one/feed")).toBeNull();
    expect(normalizeInternalRouteHref("//evil.example/one/feed")).toBeNull();
  });

  it("opens Personal World Model inside the Profile pane, never redirecting to its route", () => {
    // proxy.ts presents /one/profile/world-model as the pane, so the pane must
    // render the model itself; leaving for the route loops back here.
    expect(profileMenuGroups(false).flatMap(group => group.entries)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "world-model", voiceControlId: "profile_world_model" }),
    ]));
    expect(profilePageSource).toContain('"world-model": () => openVaultBackedPanel("world-model")');
    const panel = profilePageSource.split('activePanel === "world-model") {')[1]?.split("} else if (")[0] ?? "";
    expect(panel).toContain("<PersonalWorldModelPage");
    expect(panel).toContain("embedded");
    expect(panel).toContain('onManageDetails={() => openVaultBackedPanel("my-data")}');
    // Negative controls: no pane-only exclusion and no redirect to the route.
    expect(profilePageSource).not.toMatch(/!isPanePresentation &&\s*activePanel === "world-model"/);
    expect(profilePageSource).not.toContain("buildProfileWorldModelRoute");
    expect(profilePageSource).not.toContain("paneWorldModelRedirect");
    expect(readFileSync(join(process.cwd(), "app/one/profile/world-model/page.tsx"), "utf8")).toContain(
      'export { default } from "@/app/profile/profile-workspace-page"',
    );
  });

  it("retains a model invitation through vault unlock", () => {
    expect(profilePageSource).toContain('const worldModelClaim = activePanel === "world-model" && searchParams.has("claim")');
    expect(profilePageSource).toMatch(/if \(\s*activePanel &&\s*!worldModelClaim &&/);
    expect(profilePageSource).toContain('claimQuery?.delete("unlock_vault")');
    expect(profilePageSource).toContain('`${pathname}?${claimQuery.toString()}`');
  });

  it("keeps Security as the sole Profile entry for vault controls", () => {
    expect(profilePageSource).not.toContain('className="min-w-[148px]"');
    expect(profilePageSource).not.toContain('voiceControlId="profile_vault"');
    expect(profilePageSource).not.toContain("const openVaultSettingsRow");
    expect(profilePageSource).toContain('entry.id === "security" ? "profile_security"');
    expect(profilePageSource).toContain(
      'entry.id === "security" ? "route.profile_security_panel"',
    );
    expect(profilePageSource).not.toContain(
      'voiceActionId="route.profile_security"',
    );
  });
});
