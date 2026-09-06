import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const profilePageSource = readFileSync(
  join(process.cwd(), "app/profile/profile-workspace-page.tsx"),
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
      "Required security or legal records may be retained under our policy.",
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
    expect(profilePageSource).toContain('"Reset account"');
    expect(profilePageSource).toContain(
      "AccountService.resetAccount(resolution.token)",
    );
    expect(profilePageSource).toContain("router.replace(ROUTES.ONE_SETUP)");
    expect(profilePageSource).toContain("setOnboardingRequiredCookie(true)");
  });
});
