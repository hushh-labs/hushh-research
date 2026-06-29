import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const profilePageSource = readFileSync(
  join(process.cwd(), "app/profile/page.tsx"),
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
    expect(profilePageSource).toContain(
      "No vault exists yet. This deletes cloud-linked account records.",
    );
    expect(profilePageSource).not.toContain("Create vault to delete account");
  });

  it("keeps the One account delete confirmation button mobile-safe", () => {
    expect(profilePageSource).toContain('"Yes, delete my account"');
    expect(profilePageSource).toContain("!whitespace-normal");
    expect(profilePageSource).toContain("min-h-10");
    expect(profilePageSource).toContain("sm:min-w-[12rem]");
  });

  it("deletes the whole One account with no persona-scoped choice", () => {
    expect(profilePageSource).toContain(
      'const effectiveDeleteTarget: AccountDeletionTarget = "both";',
    );
    expect(profilePageSource).toContain("Delete your One account?");
    expect(profilePageSource).not.toContain("Delete Investor, RIA");
    expect(profilePageSource).not.toContain('"Yes, Delete Investor"');
    expect(profilePageSource).not.toContain('"Yes, Delete RIA"');
  });

  it("offers a reset-account path that keeps the account and re-runs setup", () => {
    expect(profilePageSource).toContain("Reset your One account?");
    expect(profilePageSource).toContain('"Yes, reset my account"');
    expect(profilePageSource).toContain("AccountService.resetAccount(resolution.token)");
    expect(profilePageSource).toContain("router.replace(ROUTES.ONE_SETUP)");
    expect(profilePageSource).toContain("setOnboardingRequiredCookie(true)");
  });
});
