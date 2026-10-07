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

describe("Gmail workspace background loading contract", () => {
  it("keeps the Gmail shell actionable while connection status uses an accessible skeleton", () => {
    expect(source).toContain('aria-label="Checking your Gmail status"');
    expect(source).toContain("Checking your Gmail status");
    expect(source).toContain("<Skeleton className=");
    expect(source).toContain("onClick={() => void handleConnectGmail()}");
    expect(source).not.toContain("if (loadingStatus) return");
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

  it("reserves the receipt list with accessible rows during a cold load", () => {
    expect(source).toContain("function ReceiptListSkeleton()");
    expect(source).toContain('aria-label="Loading receipts"');
    expect(source).toContain("RECEIPT_PLACEHOLDER_ROWS = 8");
    expect(source).toContain(
      "receiptsWorkspaceActive && (isConnected || receipts.length > 0)",
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
