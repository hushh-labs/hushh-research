import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

import {
  readResolvedConsentCardReceipts,
  removeResolvedConsentCardReceipt,
  saveResolvedConsentCardReceipt,
  serializeVisibleIncomingConsentCards,
} from "@/lib/agent/consent-card-receipts";
import { parseRequestProgress } from "@/components/agent/consent/request-progress";
import { RequesterProgressBody } from "@/components/agent/consent/requester-consent-card";
import { IncomingConsentChatBanner } from "@/components/consent/incoming-consent-chat-banner";
import {
  SpecialistPendingConsentRequestCard,
  type SpecialistPendingConsentRequestItem,
} from "@/components/agent/specialist-directive-card";
import type { AgentMessage } from "@/components/agent/workspace/agent-message-transforms";

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    getIdToken: vi.fn().mockResolvedValue("fake-id-token"),
  },
}));

vi.mock("@/lib/services/scope-commerce-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/scope-commerce-service")>();
  return {
    ...actual,
    ScopeCommerceService: {
      ...actual.ScopeCommerceService,
      scopeRequest: vi.fn().mockResolvedValue({
        request_id: "req-paid-1",
        role: "owner",
        scope_handle: "professional.agent_memory",
        machine_scope: "attr.professional.agent_memory",
        duration_seconds: 604800,
        tariff: { price_cents: 1, base_duration_seconds: 604800 },
        purchase: {
          id: "purch-1",
          status: "reserved",
          amount_cents: 1,
          processing_fee_micro_usd: 300_000,
          net_earnings_micro_usd: -290_000,
        },
        negative_net_acknowledgement: {
          version: 1,
          binding: "bind-neg-1",
          net_earnings_micro_usd: -290_000,
        },
      }),
    },
  };
});

describe("paid scope chat UX, live card receipts, and chat-first banner", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("serializes popped incoming consent cards for dynamic turn context without raw secrets", () => {
    const item: SpecialistPendingConsentRequestItem = {
      id: "req-paid-1",
      requesterLabel: "Kushal Trivedi",
      scope: "attr.professional.agent_memory",
      scopeDescription: "Professional agent memory",
      expiryHours: 168,
      reason: "To review his background for a project",
      status: "pending",
      metadata: {
        commercial_required: true,
        bundle_price_coins: 1,
        commerce_status: "awaiting_owner",
      },
    };
    const messages: AgentMessage[] = [
      {
        id: "m1",
        role: "assistant",
        text: "",
        timestamp: "10:00 AM",
        status: "done",
        specialistDirective: {
          delegateAgentId: "agent_nav",
          directive: {
            kind: "prompt",
            payload: { kind: "pending_consent_request", item },
          },
          message: "",
          stateChanged: true,
        },
      },
    ];

    const serialized = serializeVisibleIncomingConsentCards(messages);
    expect(serialized).toHaveLength(1);
    expect(serialized[0]).toMatchObject({
      requester_label: "Kushal Trivedi",
      labels: ["Professional agent memory"],
      status: "pending",
      reason: "To review his background for a project",
      duration_label: "7 days",
      price_coins: 1,
      commerce_status: "awaiting_owner",
    });
  });

  it("persists and cleans up compact resolved consent card receipts per owner", () => {
    const item: SpecialistPendingConsentRequestItem = {
      id: "req-1",
      bundleId: "bundle-1",
      requesterLabel: "Kushal Trivedi",
      scope: "attr.identity.communication_preferences",
      scopeDescription: "Communication preferences",
      expiryHours: 168,
      reason: "Dinner plans",
      status: "pending",
      metadata: { commercial_required: false },
    };

    saveResolvedConsentCardReceipt("owner-a", item, "approved", 168);
    expect(readResolvedConsentCardReceipts("owner-b")).toHaveLength(0);

    const receipts = readResolvedConsentCardReceipts("owner-a");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.item.status).toBe("approved");
    expect(receipts[0]!.item.id).toBe("req-1");

    removeResolvedConsentCardReceipt("owner-a", "req-1");
    expect(readResolvedConsentCardReceipts("owner-a")).toHaveLength(0);
  });

  it("parses and renders paid coin reservation, settlement, and refund pills on RequesterProgressBody", () => {
    const progress = parseRequestProgress({
      requested_at: "2026-11-22T18:00:00Z",
      outcome: "pending",
      fields: [{ label: "Agent memory", status: "pending" }],
      commerce: { total_coins: 1, status: "reserved" },
    });
    expect(progress?.commerce).toEqual({ totalCoins: 1, status: "reserved" });

    render(
      <RequesterProgressBody
        progress={progress!}
        personName="Kushal Trivedi"
        purpose="To review his background"
      />,
    );
    expect(screen.getByTestId("requester-commerce-pill")).toHaveTextContent(
      "1 Hussh coin ($0.01) reserved",
    );
  });

  it("shows paid terms, locks funded duration, and requires negative-net acknowledgement inline", async () => {
    const onApprove = vi.fn();
    const item: SpecialistPendingConsentRequestItem = {
      id: "req-paid-1",
      requesterLabel: "Kushal Trivedi",
      scope: "attr.professional.agent_memory",
      scopeDescription: "Professional agent memory",
      expiryHours: 168,
      reason: "To review his background",
      status: "pending",
      metadata: {
        commercial_required: true,
        upfront_price_reviewed: true,
        bundle_price_coins: 1,
        commerce_status: "awaiting_owner",
      },
    };

    render(
      <SpecialistPendingConsentRequestCard
        item={item}
        onApprove={onApprove}
        onDeny={vi.fn()}
        onDetails={vi.fn()}
      />,
    );

    expect(screen.getByTestId("specialist-pending-consent-commerce")).toHaveTextContent(
      "1 Hussh coin ($0.01)",
    );
    expect(screen.getByTestId("specialist-pending-consent-locked-term")).toHaveTextContent(
      "7 days · Funded",
    );
    expect(screen.queryByTestId("specialist-pending-consent-term-select")).toBeNull();

    const ackCheckbox = await waitFor(() =>
      screen.getByTestId("specialist-pending-consent-negative-ack"),
    );
    const approveBtn = screen.getByTestId("specialist-pending-consent-approve");
    expect(approveBtn).toBeDisabled();

    fireEvent.click(ackCheckbox);
    expect(approveBtn).not.toBeDisabled();

    fireEvent.click(approveBtn);
    expect(onApprove).toHaveBeenCalledWith(
      item,
      expect.objectContaining({
        version: 1,
        binding: "bind-neg-1",
        acknowledged: true,
      }),
    );
  });

  it("renders a sleek Chat-first incoming consent banner on non-Chat routes", () => {
    const onReview = vi.fn();
    const onDismiss = vi.fn();
    render(
      <IncomingConsentChatBanner
        item={{
          requestId: "req-paid-1",
          requesterLabel: "Kushal Trivedi",
          scopeLabel: "Professional agent memory",
          priceCoins: 1,
        }}
        onReviewInChat={onReview}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByTestId("incoming-consent-chat-banner")).toHaveTextContent(
      "Kushal Trivedi wants your Professional agent memory",
    );
    expect(screen.getByTestId("incoming-consent-chat-banner")).toHaveTextContent(
      "1 Hussh coin ($0.01) reserved",
    );
    fireEvent.click(screen.getByTestId("incoming-consent-review-in-chat"));
    expect(onReview).toHaveBeenCalledTimes(1);
  });
});
