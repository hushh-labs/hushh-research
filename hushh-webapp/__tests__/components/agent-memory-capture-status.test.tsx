import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentMemoryCaptureStatus } from "@/components/agent/agent-memory-capture-status";
import { emptyPkmSaveReceipt } from "@/lib/agent/pkm-save-receipt";

afterEach(cleanup);
describe("quiet Memory capture receipt", () => {
  it("keeps a valid no-op invisible", () => {
    render(
      <AgentMemoryCaptureStatus status={{ phase: "skipped", saved: 0 }} />,
    );
    expect(screen.queryByTestId("memory-capture-status")).toBeNull();
  });
  it("updates one status independently of the answer without claiming an early save", () => {
    const { rerender } = render(
      <AgentMemoryCaptureStatus status={{ phase: "preparing", saved: 0 }} />,
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByRole("link")).toBeNull();
    rerender(
      <AgentMemoryCaptureStatus status={{ phase: "saved", saved: 2 }} />,
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe(
      "2 details saved privately",
    );
    expect(
      screen.getByRole("link", { name: "View Memory" }).getAttribute("href"),
    ).toBe("/one/pkm/recent");
    expect(screen.getByRole("link").className).toContain("min-h-11");
  });
  it("offers recovery without navigating automatically or exposing fields", () => {
    render(
      <AgentMemoryCaptureStatus status={{ phase: "partial", saved: 1 }} />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "some details still need attention",
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
  it("requires the exact proposed write and affected people before approval", async () => {
    const confirm = vi.fn(async () => undefined);
    const receipt = { ...emptyPkmSaveReceipt(), saved: 1, needsOwner: 1,
      items: [{ id: "pending", domainLabel: "Identity", text: "Truncated…", outcome: "needs_owner" as const }] };
    const pendingCards = [{ card_id: "pending", source_text: "Full synthetic detail to inspect before saving",
      write_mode: "confirm_first" as const, target_domain: "identity",
      candidate_payload: { passport_number: "SYNTHETIC-123" },
      sharing_impact: {
        active_recipient_count: 1, recipient_labels: ["Ava"],
        enters_next_export_revision: true, summary: "One recipient",
        affected_grant_ids: [], affected_export_ids: [],
      } }];
    const { rerender } = render(
      <AgentMemoryCaptureStatus status={{ phase: "partial", saved: 1, receipt }} onConfirmNeedsOwner={confirm} />,
    );
    expect(screen.queryByRole("button", { name: "Save it too" })).toBeNull();
    rerender(<AgentMemoryCaptureStatus status={{ phase: "partial", saved: 1, receipt }}
      pendingCards={[{ ...pendingCards[0], sharing_impact: { ...pendingCards[0].sharing_impact, recipient_labels: [] } }]}
      canConfirmNeedsOwner onConfirmNeedsOwner={confirm} />);
    expect(screen.getByRole("button", { name: "Save it too" })).toBeDisabled();
    rerender(<AgentMemoryCaptureStatus status={{ phase: "partial", saved: 1, receipt }}
      pendingCards={pendingCards} onConfirmNeedsOwner={confirm} />);
    expect(screen.getByRole("button", { name: "Save it too" })).toBeDisabled();
    rerender(<AgentMemoryCaptureStatus status={{ phase: "partial", saved: 1, receipt }}
      pendingCards={pendingCards} canConfirmNeedsOwner onConfirmNeedsOwner={confirm} />);
    expect(screen.getByTestId("memory-save-owner-review")).toHaveTextContent("Full synthetic detail to inspect before saving");
    expect(screen.getByTestId("memory-save-owner-review")).toHaveTextContent("Saves to Identity");
    expect(screen.getByTestId("memory-save-owner-review")).toHaveTextContent("SYNTHETIC-123");
    expect(screen.getByTestId("memory-save-owner-review")).toHaveTextContent("Ava");
    fireEvent.click(screen.getByRole("button", { name: "Save it too" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(pendingCards));
  });
});
