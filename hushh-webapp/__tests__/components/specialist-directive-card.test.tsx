import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  SpecialistConsentActionsCard,
  SpecialistPendingConsentRequestCard,
  SpecialistConsentRequiredCard,
} from "@/components/agent/specialist-directive-card";

describe("SpecialistConsentRequiredCard", () => {
  it("renders the agent permission request and actions", () => {
    const onOpenConsent = vi.fn();
    const onCancel = vi.fn();

    render(
      <SpecialistConsentRequiredCard
        agentId="agent_nav"
        requiredScope="agent.nav.review"
        reason="missing_scope"
        onOpenConsent={onOpenConsent}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByTestId("specialist-consent-required-card")).toBeTruthy();
    expect(screen.getByText("Nav needs permission")).toBeTruthy();
    expect(screen.getByText(/review your consent and privacy access/)).toBeTruthy();
    expect(screen.getByText("missing_scope")).toBeTruthy();

    fireEvent.click(screen.getByTestId("specialist-consent-open"));
    expect(onOpenConsent).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("specialist-consent-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("SpecialistConsentActionsCard", () => {
  it("renders revoke and details actions for active consent items", () => {
    const onRevoke = vi.fn();
    const onDetails = vi.fn();
    const item = {
      id: "one_location_grant:grant_1",
      label: "Gautam Ahuja",
      summary: "Gautam Ahuja can view your live location",
      scope: "cap.location.live.view",
      expiresAt: "2026-07-04T01:53:37.924978+00:00",
      metadata: {
        request_source: "one_location_share_grant",
        grant_id: "grant_1",
      },
      actions: ["revoke", "details"],
    };

    render(
      <SpecialistConsentActionsCard
        items={[item]}
        onRevoke={onRevoke}
        onDetails={onDetails}
      />,
    );

    expect(screen.getByTestId("specialist-consent-actions-card")).toBeTruthy();
    expect(screen.getByText("Manage access")).toBeTruthy();
    expect(screen.getByText("Gautam Ahuja")).toBeTruthy();
    expect(screen.getByText(/^Until /)).toBeTruthy();

    fireEvent.click(screen.getByTestId("specialist-consent-revoke"));
    expect(onRevoke).toHaveBeenCalledWith(item);

    fireEvent.click(screen.getByTestId("specialist-consent-details"));
    expect(onDetails).toHaveBeenCalledWith(item);
  });

  it("renders revoke for shared location grants too", () => {
    const onRevoke = vi.fn();
    const onDetails = vi.fn();
    const item = {
      id: "one_location_grant:grant_shared",
      label: "Gautam Ahuja",
      summary: "Gautam Ahuja can view your live location",
      scope: "cap.location.live.view",
      metadata: {
        request_source: "one_location_share_grant",
        grant_id: "grant_shared",
        section: "shared",
      },
      actions: ["details"],
    };

    render(
      <SpecialistConsentActionsCard
        items={[item]}
        onRevoke={onRevoke}
        onDetails={onDetails}
      />,
    );

    fireEvent.click(screen.getByTestId("specialist-consent-revoke"));
    expect(onRevoke).toHaveBeenCalledWith(item);

    fireEvent.click(screen.getByTestId("specialist-consent-details"));
    expect(onDetails).toHaveBeenCalledWith(item);
  });

  it("renders revoke for active location grants even when an older payload only lists details", () => {
    const onRevoke = vi.fn();
    const onDetails = vi.fn();
    const item = {
      id: "one_location_grant:grant_1",
      label: "Gautam Ahuja",
      summary: "Gautam Ahuja can view your live location",
      scope: "cap.location.live.view",
      metadata: {
        request_source: "one_location_share_grant",
        grant_id: "grant_1",
      },
      actions: ["details"],
    };

    render(
      <SpecialistConsentActionsCard
        items={[item]}
        onRevoke={onRevoke}
        onDetails={onDetails}
      />,
    );

    fireEvent.click(screen.getByTestId("specialist-consent-revoke"));
    expect(onRevoke).toHaveBeenCalledWith(item);
  });

  it("renders revoked items with a disabled revoked button", () => {
    const onRevoke = vi.fn();
    const onDetails = vi.fn();
    const item = {
      id: "one_location_grant:grant_1",
      label: "Gautam Ahuja",
      summary: "Gautam Ahuja can no longer view your live location",
      scope: "cap.location.live.view",
      metadata: {
        request_source: "one_location_share_grant",
        grant_id: "grant_1",
      },
      actions: ["details"],
      status: "revoked",
    } as const;

    render(
      <SpecialistConsentActionsCard
        items={[item]}
        onRevoke={onRevoke}
        onDetails={onDetails}
      />,
    );

    expect(screen.getAllByText("Revoked")).toHaveLength(2);
    expect(
      (screen.getByTestId("specialist-consent-revoked") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByTestId("specialist-consent-revoke")).toBeNull();

    fireEvent.click(screen.getByTestId("specialist-consent-details"));
    expect(onDetails).toHaveBeenCalledWith(item);
    expect(onRevoke).not.toHaveBeenCalled();
  });
});

describe("SpecialistPendingConsentRequestCard", () => {
  it("renders a pending consent request with approve, deny, and details actions", () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const onDetails = vi.fn();
    const item = {
      id: "req_123",
      requesterLabel: "Macy's",
      scope: "attr.profile.city",
      scopeDescription: "City",
      requestedAt: 1783212000000,
      approvalTimeoutAt: 1783215600000,
      reason: "Update your brand profile",
      additionalAccessSummary: "Only your city will be shared.",
      status: "pending",
    } as const;

    render(
      <SpecialistPendingConsentRequestCard
        item={item}
        onApprove={onApprove}
        onDeny={onDeny}
        onDetails={onDetails}
      />,
    );

    expect(screen.getByTestId("specialist-pending-consent-request-card")).toBeTruthy();
    expect(screen.getByText("Consent request")).toBeTruthy();
    expect(screen.getByText("Macy's is asking for City.")).toBeTruthy();
    expect(screen.getByText("Only your city will be shared.")).toBeTruthy();
    expect(screen.getByText("Reason: Update your brand profile")).toBeTruthy();

    fireEvent.click(screen.getByTestId("specialist-pending-consent-approve"));
    expect(onApprove).toHaveBeenCalledWith(item);

    fireEvent.click(screen.getByTestId("specialist-pending-consent-deny"));
    expect(onDeny).toHaveBeenCalledWith(item);

    fireEvent.click(screen.getByTestId("specialist-pending-consent-details"));
    expect(onDetails).toHaveBeenCalledWith(item);
  });

  it("renders resolved requests without approve or deny actions", () => {
    const item = {
      id: "req_approved",
      requesterLabel: "Chase",
      scope: "attr.profile.city",
      scopeDescription: "City",
      status: "approved",
    } as const;

    render(
      <SpecialistPendingConsentRequestCard
        item={item}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDetails={vi.fn()}
      />,
    );

    expect(screen.getByText("Approved")).toBeTruthy();
    expect(screen.queryByTestId("specialist-pending-consent-approve")).toBeNull();
    expect(screen.queryByTestId("specialist-pending-consent-deny")).toBeNull();
    expect(screen.getByTestId("specialist-pending-consent-details")).toBeTruthy();
  });
});
