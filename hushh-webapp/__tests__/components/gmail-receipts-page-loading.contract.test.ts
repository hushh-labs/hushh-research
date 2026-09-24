import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "components/gmail/gmail-receipts-page.tsx"),
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

  it("uses cached receipts first and refreshes stale receipt data silently in the background", () => {
    expect(source).toContain("getCachedGmailReceipts(user.uid)");
    expect(source).toContain("preserveCachedItems: true");
    expect(source).toContain("silent: cached.items.length > 0");
  });

  it("reserves the receipt list with accessible rows during a cold load", () => {
    expect(source).toContain("function ReceiptListSkeleton()");
    expect(source).toContain('aria-label="Loading receipts"');
    expect(source).toContain("RECEIPT_PLACEHOLDER_ROWS = 8");
    expect(source).toContain("receiptsContentActive && showReceiptPlaceholders");
    expect(source).toContain("receiptsWorkspaceActive && !showReceiptOnboarding");
    expect(source).toContain("setReceiptListReady(false)");
    expect(source).toContain("silent: cached.items.length > 0");
  });
});
