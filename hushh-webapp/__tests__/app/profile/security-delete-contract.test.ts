import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const profilePageSource = readFileSync(
  join(process.cwd(), "components/profile/profile-workspace-page.tsx"),
  "utf8",
);
const topAppBarSource = readFileSync(
  join(process.cwd(), "components/app-ui/top-app-bar.tsx"),
  "utf8",
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

  it("allows no-vault account deletion without forcing vault creation", () => {
    expect(profilePageSource).toContain("if (!nextHasVault)");
    expect(profilePageSource).toContain("setShowDeleteConfirm(true);");
    expect(profilePageSource).toContain("Deletes cloud-linked records.");
    expect(profilePageSource).not.toContain("Create vault to delete account");
  });

  it("keeps the One account delete confirmation button mobile-safe", () => {
    expect(profilePageSource).toContain('"Delete account"');
    expect(profilePageSource).toContain('variant="destructive"');
    expect(profilePageSource).toContain("min-h-10");
    expect(profilePageSource).toContain("sm:min-w-[10rem]");
  });

  it("uses the same destructive settlement from Profile and setup chrome", () => {
    expect(profilePageSource).toContain("executeVerifiedAccountDeletion");
    expect(topAppBarSource).toContain("executeVerifiedAccountDeletion");
    expect(topAppBarSource).toContain("requestDeleteAccount");
    expect(topAppBarSource).toContain("Unlock Vault to Delete Account");
    expect(topAppBarSource).toContain("skipFcmCleanup: true");
    expect(deleteFlowSource).toContain(
      "result = await AccountService.deleteAccount(",
    );
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
      "Deletes account, Vault, data, and access. Required records may remain. Can’t undo.",
    );
    expect(profilePageSource).toContain("DELETE_ACCOUNT_DIALOG_TITLE");
    expect(topAppBarSource).toContain("DELETE_ACCOUNT_DIALOG_TITLE");
    expect(profilePageSource).toContain(
      'buildLoginRouteWithAuthSessionNotice("account_deleted")',
    );
    expect(topAppBarSource).toContain(
      'buildLoginRouteWithAuthSessionNotice("account_deleted")',
    );
    expect(profilePageSource).not.toContain("Delete Investor, RIA");
    expect(profilePageSource).not.toContain('"Yes, Delete Investor"');
    expect(profilePageSource).not.toContain('"Yes, Delete RIA"');
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
