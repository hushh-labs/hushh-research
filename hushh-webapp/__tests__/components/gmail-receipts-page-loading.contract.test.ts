import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "components/gmail/gmail-receipts-page.tsx"),
  "utf8",
);
const profileSource = readFileSync(
  join(process.cwd(), "components/profile/profile-workspace-page.tsx"),
  "utf8",
);
const setupSource = readFileSync(join(process.cwd(), "app/one/setup/email/email-onboarding-setup-client.tsx"), "utf8");

function expectOwnerScopedKycIntake(pageSource: string, emailSetupSource: string) {
  expect(pageSource).toContain("verificationIntake?.ownerId === user?.uid");
  expect(pageSource).toContain("verificationIntake?.vaultKey === vaultKey");
  expect(pageSource).toContain('const verificationDraft = verificationIntakeCurrent ? verificationIntake?.draft ?? "" : "";');
  expect(pageSource).toContain("const verificationDeferred = verificationIntakeCurrent ? verificationIntake?.deferred ?? false : false;");
  expect(emailSetupSource).toContain("identityStatus?.ownerId === user?.uid && identityStatus?.vaultKey === vaultKey");
  expect(emailSetupSource).toContain("const identityPrefaceComplete = identityStatusCurrent && identityStatus?.complete;");
  expect(emailSetupSource).toContain("setResult(completed, false)");
  expect(emailSetupSource).toContain("key={user.uid}");
}

function expectOwnerScopedReceiptProjection(pageSource: string) {
  expect(pageSource).toContain(
    "displayedReceiptScopeRef.current === receiptDisplayScope",
  );
  expect(pageSource).toContain(
    "const visibleReceipts = useMemo(() => receiptDisplayScopeCurrent ? receipts : [], [receiptDisplayScopeCurrent, receipts]);",
  );
  expect(pageSource).toContain(
    "const visibleTotal = receiptDisplayScopeCurrent ? total : 0;",
  );
  expect(pageSource).toContain("receipts={visibleReceipts}");
  expect(pageSource).toContain("receipt_count: visibleTotal");
  expect(pageSource).toContain(
    "receiptCount={shouldShowReceiptCount ? visibleTotal : undefined}",
  );
  expect(pageSource).toContain(
    "receiptListReady && receiptDisplayScopeCurrent",
  );
  expect(pageSource).not.toContain("receipts={receipts}");
}

describe("Gmail workspace background loading contract", () => {
  it("hides previous-owner KYC drafts and intake completion synchronously on owner/key transitions", () => {
    expectOwnerScopedKycIntake(source, setupSource);
    expect(() => expectOwnerScopedKycIntake(source.replace(
      'const verificationDraft = verificationIntakeCurrent ? verificationIntake?.draft ?? "" : "";',
      'const verificationDraft = verificationIntake?.draft ?? "";',
    ), setupSource)).toThrow();
    expect(() => expectOwnerScopedKycIntake(source, setupSource.replace(
      "const identityPrefaceComplete = identityStatusCurrent && identityStatus?.complete;",
      "const identityPrefaceComplete = identityStatus?.complete;",
    ))).toThrow();
  });


  it("renders the owner/account memory cache on open without starting a scan", () => {
    expect(source).toContain(
      "getCachedGmailReceipts(user.uid, receiptAccountKey)",
    );
    expect(source).toContain("cachedGmailReceiptDisplayItems(cached)");
    expect(source).toContain("setReceiptListReady(true)");
    expect(source).not.toContain("every mount still performs");
    expect(source).toContain("setLoadingReceipts(true)");
    expect(source).not.toContain("preserveCachedItems");
    expect(source).not.toContain("silent:");
  });

  it("hides previous owner/account rows, detail entry, and counts before the clearing effect runs", () => {
    expect(source).toContain(
      '`${user.uid}\\u0000${String(receiptAccountKey || "")}`',
    );
    expectOwnerScopedReceiptProjection(source);
    expect(source).toContain("receiptCompletion?.scope === receiptDisplayScope ? receiptCompletion?.count ?? 0 : 0");

    // Negative controls: removing either render-time gate must fail this
    // contract even though the clearing effect still exists.
    expect(() =>
      expectOwnerScopedReceiptProjection(
        source.replace(
          "const visibleReceipts = useMemo(() => receiptDisplayScopeCurrent ? receipts : [], [receiptDisplayScopeCurrent, receipts]);",
          "const visibleReceipts = useMemo(() => receipts, [receiptDisplayScopeCurrent, receipts]);",
        ),
      ),
    ).toThrow();
    expect(() =>
      expectOwnerScopedReceiptProjection(
        source.replace("[receiptDisplayScopeCurrent, receipts]", "[receipts]"),
      ),
    ).toThrow();
    expect(() =>
      expectOwnerScopedReceiptProjection(
        source.replace(
          "const visibleTotal = receiptDisplayScopeCurrent ? total : 0;",
          "const visibleTotal = total;",
        ),
      ),
    ).toThrow();
    expect(() =>
      expectOwnerScopedReceiptProjection(
        source.replace(
          "receiptCount={shouldShowReceiptCount ? visibleTotal : undefined}",
          "receiptCount={total}",
        ),
      ),
    ).toThrow();
  });

  it("reserves the receipt list with accessible rows during a cold load", () => {
    expect(source).toContain("function ReceiptListSkeleton()");
    expect(source).toContain('aria-label="Loading receipts"');
    expect(source).toContain("RECEIPT_PLACEHOLDER_ROWS = 8");
    expect(source).toContain(
      "receiptsWorkspaceActive && isConnected",
    );
    expect(source).toContain(
      "showReceiptPlaceholders ? <ReceiptListSkeleton /> : null",
    );
    expect(source).toContain("setReceiptListReady(false)");
    expect(source).toContain("(loadingReceipts ||");
  });

  it("uses only the backend live scan as the receipt refresh authority", () => {
    expect(source).toContain("GmailReceiptsService.scanReceipts");
    expect(source).toContain(
      "receiptSyncAvailable && (receiptScanInProgress || loadingReceipts)",
    );
    expect(source).toContain("receiptScanAbortRef.current && receiptScanPromiseRef.current");
    expect(source).not.toContain("prepareDeviceReceiptSync");
    expect(source).not.toContain("beginDeviceReceiptSyncAuthorization");
  });

  it("does not broaden backend receipt scanning into profile settings", () => {
    expect(profileSource).not.toContain("GmailReceiptsService.scanReceipts");
    expect(profileSource).not.toContain("receipt_live_scan_available");
    expect(profileSource).not.toContain("beginDeviceReceiptSyncAuthorization");
  });
});
