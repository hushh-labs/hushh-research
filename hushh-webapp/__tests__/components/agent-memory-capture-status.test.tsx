import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: navigation.push }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "owner-1" } }) }));

import { AgentMemoryCaptureStatus } from "@/components/agent/agent-memory-capture-status";
import { emptyPkmSaveReceipt } from "@/lib/agent/pkm-save-receipt";
import { hasReservedOfferPrefill, takeReservedOfferPrefill, toReservedOfferItem } from "@/lib/pkm/reserved-offer";
import { reservedEntryFor, reservedOfferLabel } from "@/lib/pkm/reserved-branches";

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
  it("offers the owning screen and hands the prefill over in memory, never in the URL", () => {
    navigation.push.mockReset();
    const receipt = {
      ...emptyPkmSaveReceipt(),
      saved: 1,
      offers: [
        {
          id: "home",
          ownerFeature: "location",
          label: "Add as Home in Location",
          routePattern: "/one/location",
          actionId: "route.one_location",
          prefill: { kind: "location_saved_place" as const, category: "home" as const, label: "" },
        },
        {
          id: "amex",
          ownerFeature: "wallet",
          label: "Add Amex Gold to Wallet",
          routePattern: "/one/wallet",
          actionId: "route.one_wallet",
          prefill: { kind: "wallet_card" as const, nickname: "Amex Gold" },
        },
      ],
    };
    render(<AgentMemoryCaptureStatus status={{ phase: "saved", saved: 1, receipt }} />);
    const rows = screen.getAllByTestId("reserved-offer-row");
    expect(rows.map((row) => row.textContent)).toEqual(["Add as Home in Location", "Add Amex Gold to Wallet"]);

    fireEvent.click(screen.getByRole("button", { name: "Add Amex Gold to Wallet" }));
    expect(navigation.push).toHaveBeenCalledWith("/one/wallet");
    // The route is the registry's, with nothing of the fact in it.
    expect(JSON.stringify(navigation.push.mock.calls)).not.toMatch(/Amex|Gold|nickname/i);
    // The owning screen takes the prefill once, for this owner only.
    expect(takeReservedOfferPrefill({ ownerUserId: "someone-else", ownerFeature: "wallet", kind: "wallet_card" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add Amex Gold to Wallet" }));
    expect(takeReservedOfferPrefill({ ownerUserId: "owner-1", ownerFeature: "wallet", kind: "wallet_card" })).toEqual({
      kind: "wallet_card",
      nickname: "Amex Gold",
    });
    expect(takeReservedOfferPrefill({ ownerUserId: "owner-1", ownerFeature: "wallet", kind: "wallet_card" })).toBeNull();
  });

  it("opens an identity fact's offer on Mail's KYC tab, with nothing of the fact in the link", () => {
    navigation.push.mockReset();
    // The offer as the server builds it from the registry entry.
    const entry = reservedEntryFor("identity", "identity_profile")!;
    const offer = toReservedOfferItem("legal-name", {
      domain: "identity",
      branch: "identity_profile",
      subject: "legal name",
      owner_feature: entry.ownerFeature,
      agent_memory_sibling: entry.agentMemorySibling!,
      offer_action: {
        route_pattern: entry.offerAction!.routePattern,
        action_id: entry.offerAction!.actionId,
        label: reservedOfferLabel(entry.offerAction!, "legal name"),
      },
      registry_version: 1,
    });
    expect(offer).toMatchObject({ routePattern: "/one/gmail?workspace=kyc", label: "Review legal name in Mail", prefill: null });
    render(<AgentMemoryCaptureStatus status={{ phase: "saved", saved: 1, receipt: { ...emptyPkmSaveReceipt(), saved: 1, offers: [offer!] } }} />);

    fireEvent.click(screen.getByRole("button", { name: "Review legal name in Mail" }));
    expect(navigation.push).toHaveBeenCalledTimes(1);
    expect(navigation.push).toHaveBeenCalledWith("/one/gmail?workspace=kyc");
    expect(JSON.stringify(navigation.push.mock.calls)).not.toMatch(/legal|name/i);
    // Identity takes no prefill, so nothing is staged for the KYC tab.
    expect(hasReservedOfferPrefill({ ownerUserId: "owner-1", ownerFeature: "kyc" })).toBe(false);
  });

  it("shows no offer rows on a receipt without offers (negative control)", () => {
    render(<AgentMemoryCaptureStatus status={{ phase: "saved", saved: 1, receipt: { ...emptyPkmSaveReceipt(), saved: 1 } }} />);
    expect(screen.queryByTestId("reserved-offer-row")).toBeNull();
    expect(screen.queryByTestId("memory-save-offers")).toBeNull();
  });
});
