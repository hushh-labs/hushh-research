import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { AccountConfirmationPreparation } from "@/components/profile/account-confirmation-preparation";

const profilePageSource = readFileSync(
  join(process.cwd(), "components/profile/profile-workspace-page.tsx"),
  "utf8",
);
const topAppBarSource = readFileSync(
  join(process.cwd(), "components/app-ui/top-app-bar.tsx"),
  "utf8",
);
const onboardingSource = readFileSync(
  join(process.cwd(), "components/onboarding/onboarding-route-actions.tsx"), "utf8",
);
const deleteFlowSource = readFileSync(
  join(process.cwd(), "lib/flows/delete-account.ts"),
  "utf8",
);

describe("profile security deletion contract", () => {
  it("keeps Security reachable before vault creation", () => {
    expect(profilePageSource).toContain(
      'vaultAccess.needsVaultCreation && panel !== "security"',
    );
  });

  it("admits only current account confirmations, preserving vaultless and failed-probe policy", async () => {
    const preparation = new AccountConfirmationPreparation();
    let finish!: (hasVault: boolean) => void;
    let ownerCurrent = true;
    const confirm = vi.fn(), unlock = vi.fn(), vaultKnown = vi.fn();
    const port = { hasVault: null, ownerIsCurrent: () => ownerCurrent,
      checkVault: () => new Promise<boolean>(resolve => { finish = resolve; }),
      canMutate: () => false, confirm, unlock, vaultKnown };
    const previousVisit = preparation.request(port);
    preparation.invalidate(); // Close; Account reopens before its old probe returns.
    const currentConfirm = vi.fn();
    await preparation.request({ ...port, hasVault: false, confirm: currentConfirm });
    finish(false);
    await previousVisit;
    expect(currentConfirm).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(vaultKnown).toHaveBeenCalledTimes(1);
    const oldOwner = preparation.request(port);
    ownerCurrent = false;
    finish(false);
    await oldOwner;
    expect(confirm).not.toHaveBeenCalled();
    expect(unlock).not.toHaveBeenCalled();
    ownerCurrent = true;
    await preparation.request({ ...port, checkVault: async () => { throw new Error("Unavailable"); } });
    expect(unlock).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    await preparation.request({ ...port, hasVault: true, canMutate: () => true });
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("uses the same destructive settlement from Profile and setup chrome", () => {
    expect(topAppBarSource).toContain('import { OnboardingRouteActions }');
    expect(topAppBarSource).toContain('<OnboardingRouteActions key={user?.uid');
    expect(onboardingSource).toContain("needsCloudReview = azureAccountCleanupRequired(error)");
    expect(onboardingSource).toContain("if (!needsCloudReview) setDeleteConfirmOpen(false)");
    expect(onboardingSource).toContain("<AccountCloudCleanup");
    expect(onboardingSource).toContain("onFinish={handleDeleteAccount}");
    expect(profilePageSource).toContain("executeVerifiedAccountDeletion");
    expect(onboardingSource).toContain("executeVerifiedAccountDeletion");
    expect(onboardingSource).toContain("requestDeleteAccount");
    expect(onboardingSource).toContain("Unlock Vault to Delete Account");
    expect(onboardingSource).toContain("skipFcmCleanup: true");
    expect(deleteFlowSource).toContain(
      "performDeletion: () => AccountService.deleteAccount(",
    );
    expect(deleteFlowSource).toContain("result = await params.performDeletion();");
    expect(deleteFlowSource).toContain("confirmDeletionAfterUncertainResponse");
    expect(deleteFlowSource).toContain("account_deletion_uncertain");
    expect(deleteFlowSource).toContain("account_delete_uncertain_unverified");
    expect(deleteFlowSource).toContain("account_delete_confirmed");
    expect(deleteFlowSource).toContain("getAccountSessionStatus");
    expect(deleteFlowSource).toContain("result?.success !== true");
    expect(deleteFlowSource).toContain("result.account_deleted !== true");
    expect(deleteFlowSource).toContain("CacheSyncService.onAccountDeleted");
    expect(deleteFlowSource).toContain("UserLocalStateService.clearForUser");
    expect(deleteFlowSource).toContain("DELETE_ACCOUNT_DIALOG_TITLE");
    expect(deleteFlowSource).toContain(
      "Deletes your account, vault, memory, chats, and connections.",
    );
    expect(profilePageSource).toContain("DELETE_ACCOUNT_DIALOG_TITLE");
    expect(onboardingSource).toContain("DELETE_ACCOUNT_DIALOG_TITLE");
    expect(profilePageSource).toContain(
      'buildLoginRouteWithAuthSessionNotice("account_deleted")',
    );
    expect(onboardingSource).toContain(
      'buildLoginRouteWithAuthSessionNotice("account_deleted")',
    );
    expect(profilePageSource).not.toContain("Delete Investor, RIA");
    expect(profilePageSource).not.toContain('"Yes, Delete Investor"');
    expect(profilePageSource).not.toContain('"Yes, Delete RIA"');
  });

  it("keeps onboarding chrome canonical and shell-sized", () => {
    const shell = topAppBarSource;
    expect(shell).toContain('import { OnboardingRouteActions }');
    expect(shell).toContain('<OnboardingRouteActions key={user?.uid');
    const source = onboardingSource;
    const signOutItemStart = source.indexOf(
      "onClick={() => void handleSignOut()}",
    );
    const signOutItemSource = source.slice(
      signOutItemStart,
      source.indexOf("</DropdownMenuItem>", signOutItemStart),
    );
    const deleteItemStart = source.indexOf('variant="destructive"');
    const deleteItemSource = source.slice(
      deleteItemStart,
      source.indexOf("</DropdownMenuItem>", deleteItemStart),
    );

    expect(source).not.toContain(
      'return { label: "Set up One", interactive: false as const };',
    );
    expect(source).not.toContain("ThemeToggleCompact");
    expect(source).toContain(
      '<ShellActionSurface variant="icon" aria-label="Account actions">',
    );
    expect(deleteItemSource).toContain('variant="destructive"');
    expect(source).toContain('className="overflow-hidden rounded-[14px] p-1"');
    expect(signOutItemSource).toContain("cursor-pointer");
    expect(signOutItemSource).toContain("rounded-[10px]");
    expect(signOutItemSource).toContain("hover:!bg-[color:var(--app-accent)]");
    expect(signOutItemSource).toContain(
      "hover:!text-[color:var(--app-accent-fg)]",
    );
    expect(signOutItemSource).toContain(
      "hover:[&_svg]:!stroke-[color:var(--app-accent-fg)]",
    );
    expect(deleteItemSource).toContain("cursor-pointer");
    expect(deleteItemSource).toContain("rounded-[10px]");
    expect(deleteItemSource).toContain(
      "hover:!bg-[color:var(--app-destructive-tint)]",
    );
    expect(deleteItemSource).toContain(
      "hover:!text-destructive",
    );
    expect(deleteItemSource).toContain(
      "focus:!bg-[color:var(--app-destructive-tint)]",
    );
    expect(deleteItemSource).toContain(
      "focus:!text-destructive",
    );
    expect(deleteItemSource).not.toContain(
      "data-[variant=destructive]:focus:bg-popover",
    );
    expect(signOutItemSource).toContain("focus-visible:ring-inset");
    expect(deleteItemSource).toContain("focus-visible:ring-inset");
    expect(source).not.toContain('className="text-red-600 focus:text-red-600"');
    expect(source).not.toContain(
      'return { label: "Get started", interactive: false as const };',
    );
    expect(source).not.toContain('className="h-9 w-9 rounded-full"');
  });
  it("offers a reset-account path that keeps the account and re-runs setup", () => {
    expect(profilePageSource).toContain("Reset account?");
    expect(profilePageSource).toContain(
      "Clears saved details and setup progress. Your sign-in and vault stay.",
    );
    expect(profilePageSource).toContain('"Reset account"');
    expect(profilePageSource).toContain(
      "AccountService.resetAccount(resolution.token)",
    );
    expect(profilePageSource).toContain("router.replace(ROUTES.ONE_SETUP)");
    expect(profilePageSource).toContain("setOnboardingRequiredCookie(true)");
  });
});

describe("profile lifecycle voice settlement contract", () => {
  // Graph observations 5 and 7: reset discarded its result and ran success
  // cleanup unconditionally; delete and marketplace fired-and-forgot and
  // narrated "started" as done. The behaviour lives in
  // lib/profile/profile-action-outcomes.ts (unit-tested); this proves the
  // page consumes it rather than re-growing a bare `void` + "started".

  it("runs reset success cleanup only on a backend-confirmed reset", () => {
    expect(profilePageSource).toContain(
      "const result = await AccountService.resetAccount(resolution.token);",
    );
    expect(profilePageSource).toContain("const resetOutcome = resolveResetOutcome(result);");
    expect(profilePageSource).toContain("settlement.committed = true;");
    expect(profilePageSource).toContain("if (error instanceof AccountResetNotConfirmedError) return error.outcome;");
    expect(profilePageSource).toContain('return settlement.committed ? "reset" : "unknown";');
    expect(profilePageSource).toContain(
      "throw new AccountResetNotConfirmedError(resetOutcome);",
    );
    // The flag check sits before the first cleanup call, not after.
    const resetBody = profilePageSource.slice(
      profilePageSource.indexOf("const handleResetAccount = async ()"),
      profilePageSource.indexOf("const handleResetClick = async ()"),
    );
    expect(resetBody.indexOf("resolveResetOutcome(result)")).toBeLessThan(
      resetBody.indexOf("CacheSyncService.onAccountDeleted(user.uid)"),
    );
    expect(resetBody).toContain("error: (error: unknown) => resetErrorMessage(error)");
    expect(resetBody).not.toContain('error: "Failed to reset account. Please try again."');
  });

  it("awaits deletion and narrates its typed outcome, never 'started'", () => {
    expect(profilePageSource).toContain("const outcome = await handleDeleteAccount();");
    expect(profilePageSource).toContain("return lifecycleOutcomeToVoice(outcome);");
    expect(profilePageSource).toContain("return classifyDeletionError(error);");
    expect(profilePageSource).not.toContain("void handleDeleteAccount();\n      return {");
    expect(profilePageSource).not.toContain(
      '"Starting account deletion. You may need to unlock your vault."',
    );
  });

  it("applies the reviewed marketplace target instead of flipping, and reports the stored value", () => {
    expect(profilePageSource).toContain(
      "const handleMarketplaceOptInToggle = async (\n    target?: boolean,\n  ): Promise<MarketplaceOutcome>",
    );
    expect(profilePageSource).toContain("target ?? !marketplaceOptIn,");
    expect(profilePageSource).toContain(
      "const outcome = await handleMarketplaceOptInToggle(desired ?? undefined);",
    );
    expect(profilePageSource).toContain("return marketplaceOutcomeToVoice(outcome);");
    expect(profilePageSource).not.toContain("void handleMarketplaceOptInToggle();\n      return {");
    expect(profilePageSource).not.toContain('summary: "Updating your visibility."');
    // The manual switch still flips (no target), which is its meaning.
    expect(profilePageSource).toContain("onCheckedChange={() => void handleMarketplaceOptInToggle()}");
  });
});
