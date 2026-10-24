import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentPackageActions, DocumentPackageDetails } from "@/components/consent/document-package-review";
import type { AgentDocumentPackage } from "@/lib/services/drive-sharing-service";
import { useArmedAction } from "@/lib/ui/use-armed-action";

const packet: AgentDocumentPackage = {
  status: "ready", revision: 2, digest: "b".repeat(64), selectedCount: 1, selectedFileCount: 1,
  selectedFiles: [{ position: 1, name: "Record X.pdf" }], evaluatedCount: 0, candidateCount: 1,
  confidenceBasis: "provider_search", confidenceScore: null, importanceScore: null,
  suggestedPriceCents: 500, priceReason: "", summary: "File contents were not read.",
  coverageStatus: "unknown", gaps: [], canAllow: true,
};
const review = { purpose: { purpose: "Account statements", periodStart: "2026-07-01", periodEnd: "2026-08-31" },
  recipientEmail: "recipient@example.invalid", paymentRequired: true, priceCents: 500 };
function Package({ agentPackage = packet, locked = false, onAllow, onEditPrice }: {
  agentPackage?: AgentDocumentPackage; locked?: boolean;
  onAllow: (cents: number | null) => void; onEditPrice: () => void;
}) {
  const denyConfirm = useArmedAction();
  return <>
    <DocumentPackageDetails review={review} agentPackage={agentPackage} hairlines="" />
    <DocumentPackageActions review={review} agentPackage={agentPackage} undecided locked={locked}
      ownerDecision denyConfirm={denyConfirm} allowClass="" onAllow={onAllow}
      onDecline={() => {}} onEditPrice={onEditPrice} />
  </>;
}
afterEach(cleanup);

describe("frozen discovery package owner review", () => {
  it("shows query membership without content claims and allows only the fixed price", () => {
    const allow = vi.fn(); const edit = vi.fn();
    render(<Package onAllow={allow} onEditPrice={edit} />);
    expect(screen.getByText("Search period")).toBeVisible();
    expect(screen.queryByText("Coverage")).toBeNull();
    fireEvent.click(screen.getByText("View details"));
    expect(screen.getByText("Record X.pdf")).toBeVisible();
    expect(screen.queryByText("Agent assessment")).toBeNull();
    expect(screen.queryByText("Importance")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit price" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(allow).toHaveBeenCalledExactlyOnceWith(500);
    expect(edit).not.toHaveBeenCalled();
  });

  it("retains model assessment editing and the caller's session lock", () => {
    const allow = vi.fn(); const edit = vi.fn();
    const assessed = { ...packet, confidenceBasis: "model_assessment" as const,
      confidenceScore: 90, importanceScore: 100, evaluatedCount: 1, suggestedPriceCents: 1234 };
    const view = render(<Package agentPackage={assessed} onAllow={allow} onEditPrice={edit} />);
    fireEvent.click(screen.getByText("View details"));
    expect(screen.getByText("Agent assessment")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Edit price" }));
    expect(edit).toHaveBeenCalledOnce();
    view.rerender(<Package locked onAllow={allow} onEditPrice={edit} />);
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(allow).not.toHaveBeenCalled();
  });
});
