import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  SpecialistConsentActionsCard,
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
