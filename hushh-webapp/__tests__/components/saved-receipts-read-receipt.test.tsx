import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectorReadReceipt } from "@/components/agent/connector-read-receipt";
import type { ConnectorReadExperience } from "@/lib/agent/connector-read-receipt";
import { GmailReceiptRequestError } from "@/lib/services/gmail-receipts-service";
import {
  RECEIPT_INDEX_SCHEMA,
  type ReceiptCanonicalIndex,
} from "@/lib/profile/gmail-receipt-memory-index";

const state = vi.hoisted(() => ({
  index: null as unknown,
  resolve: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "owner-a", getIdToken: async () => "id-token" } }),
}));
vi.mock("@/lib/vault/vault-context", async (original) => ({
  ...(await original<typeof import("@/lib/vault/vault-context")>()),
  VaultContext: (await import("react")).createContext({ vaultOwnerToken: "vault-token" }),
}));
vi.mock("@/lib/agent/agent-pkm-memory", () => ({
  peekReceiptMemoryIndex: () => state.index,
}));
vi.mock("@/lib/services/gmail-receipts-service", async (original) => ({
  ...(await original<typeof import("@/lib/services/gmail-receipts-service")>()),
  GmailReceiptsService: { resolveReceiptActionLink: state.resolve },
}));
vi.mock("@/lib/utils/browser-navigation", async (original) => ({
  ...(await original<typeof import("@/lib/utils/browser-navigation")>()),
  openExternalUrlWhenResolved: state.open,
}));

const ref = (n: number) => `txn_${n.toString(16).padStart(24, "0")}`;
const sealed = `ra1.${"Q".repeat(40)}`;

function savedIndex(): ReceiptCanonicalIndex {
  const base = {
    amount: 12,
    currency: "USD",
    category: "Cloud & Infra" as const,
    transaction_date: "2026-10-01",
    identifiers: [],
    detail: null,
    logo_domain: null,
  };
  return {
    schema: RECEIPT_INDEX_SCHEMA,
    generated_at: "2026-10-09T10:00:00Z",
    total_transactions: 2,
    truncated: false,
    account_ref: null,
    transactions: [
      { ...base, ref: ref(1), merchant: "Kyari", status: "overdue",
        action: { kind: "pay_due", ref: sealed } },
      { ...base, ref: ref(2), merchant: "Supabase", status: "paid", action: null },
    ],
  };
}

const experience = (sourceRefs: string[], status: ConnectorReadExperience["status"] = "ok"): ConnectorReadExperience => ({
  type: "one.connector_read.v1",
  connector: "receipts",
  status,
  sourceRefs,
  truncated: false,
  metadataOnly: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.index = savedIndex();
  state.open.mockImplementation(async (resolveUrl: () => Promise<string>) => {
    await resolveUrl();
  });
  state.resolve.mockResolvedValue({ kind: "pay_due", url: "https://kyari.example/pay" });
});
afterEach(cleanup);

describe("saved receipts chat card", () => {
  it("offers the verified action for a cited receipt and resolves it only on click, by sealed reference", async () => {
    render(<ConnectorReadReceipt experience={experience([`receipt:${ref(1)}`, `receipt:${ref(2)}`])} />);
    expect(screen.getByRole("status").textContent).toBe("Saved receipts checked");
    expect(state.resolve).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/https?:/);

    fireEvent.click(screen.getByRole("button", { name: "Resolve payment for Kyari" }));

    await waitFor(() => expect(state.resolve).toHaveBeenCalledTimes(1));
    expect(state.resolve.mock.calls[0]![0]).toMatchObject({
      userId: "owner-a",
      action: { kind: "pay_due", ref: sealed },
    });
    expect(state.open).toHaveBeenCalledTimes(1);
    // The receipt without a verified action offers nothing.
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("shows no action when the cited receipts have none, or nothing is cited", () => {
    const { rerender } = render(<ConnectorReadReceipt experience={experience([`receipt:${ref(2)}`])} />);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<ConnectorReadReceipt experience={experience([])} />);
    expect(screen.queryByRole("button")).toBeNull();
    state.index = null;
    rerender(<ConnectorReadReceipt experience={experience([`receipt:${ref(1)}`])} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("disables only an expired action, says how to refresh it, and never shows a raw URL", async () => {
    state.open.mockRejectedValue(new Error("This receipt's link is no longer available."));
    render(<ConnectorReadReceipt experience={experience([`receipt:${ref(1)}`])} />);
    const chip = screen.getByRole("button", { name: "Resolve payment for Kyari" });
    fireEvent.click(chip);
    await waitFor(() => expect(chip).toBeDisabled());
    expect(screen.getByText("Sync again to refresh this link")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toMatch(/https?:/);
  });

  it("tells the owner to reconnect when Mail's login was rejected", async () => {
    state.open.mockRejectedValue(
      new GmailReceiptRequestError("Reconnect Gmail before loading receipts.", 401, "GMAIL_REAUTH_REQUIRED"),
    );
    render(<ConnectorReadReceipt experience={experience([`receipt:${ref(1)}`])} />);
    fireEvent.click(screen.getByRole("button", { name: "Resolve payment for Kyari" }));
    expect(await screen.findByText("Reconnect Mail, then sync again to refresh this link")).toBeVisible();
  });
});
