import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SpecialistConsentActionsCard,
  SpecialistPendingConsentRequestCard,
  SpecialistConsentRequiredCard,
} from "@/components/agent/specialist-directive-card";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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
    expect(screen.getByText(/review your sharing/)).toBeTruthy();
    expect(screen.getByText("missing_scope")).toBeTruthy();

    fireEvent.click(screen.getByTestId("specialist-consent-open"));
    expect(onOpenConsent).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("specialist-consent-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["agent_kai", "agent.kai.analyze", "look at your finances"],
    ["agent_kyc", "agent.kyc.process", "run your identity check"],
    ["agent_personal_information", "cap.pkm.marketplace.view", "see what you have made available"],
    ["agent_one", "cap.one.invoke", "act for you in the app"],
  ])("says what %s needs in the owner's words", (agentId, requiredScope, words) => {
    render(
      <SpecialistConsentRequiredCard
        agentId={agentId}
        requiredScope={requiredScope}
        onOpenConsent={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(new RegExp(words))).toBeTruthy();
    expect(screen.queryByText(new RegExp(requiredScope.replace(/\./g, "\\.")))).toBeNull();
  });

  it("never prints an unknown identifier to the owner", () => {
    // agent.yaml bans our plumbing words from the owner's screen. A scope the
    // card has no phrase for used to be dropped into the sentence verbatim.
    render(
      <SpecialistConsentRequiredCard
        agentId="agent_future"
        requiredScope="agent.future.do_things"
        onOpenConsent={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/the permission it needs/)).toBeTruthy();
    expect(screen.queryByText(/agent\.future\.do_things/)).toBeNull();
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

    // The id is the contract other code holds; the label is the owner's word.
    const revoke = screen.getByTestId("specialist-consent-revoke");
    expect(revoke).toHaveTextContent("Stop sharing");
    expect(revoke).not.toHaveTextContent("Revoke");
    fireEvent.click(revoke);
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
    // Not "Consent request". agent.yaml:62-70 bans scope/consent-lifecycle
    // vocabulary in owner-facing speech; the chrome used to undo that one line
    // after the model obeyed it. The card now says what is happening instead of
    // naming our plumbing.
    expect(screen.getByText(/wants to see/i)).toBeTruthy();
    expect(screen.getByText("Macy's is asking for City.")).toBeTruthy();
    expect(screen.getByText("Only your city will be shared.")).toBeTruthy();
    expect(screen.getByText("Reason: Update your brand profile")).toBeTruthy();

    fireEvent.click(screen.getByTestId("specialist-pending-consent-approve"));
    expect(onApprove).toHaveBeenCalledWith(item);

    fireEvent.click(screen.getByTestId("specialist-pending-consent-deny"));
    fireEvent.click(screen.getByTestId("specialist-pending-consent-deny"));
    expect(onDeny).toHaveBeenCalledWith(item);

    fireEvent.click(screen.getByTestId("specialist-pending-consent-details"));
    expect(onDetails).toHaveBeenCalledWith(item);
  });

  it("says how long the access would last when the request carries it", () => {
    render(
      <SpecialistPendingConsentRequestCard
        item={{
          id: "req_duration",
          requesterLabel: "Macy's",
          scope: "attr.profile.city",
          scopeDescription: "City",
          expiryHours: 72,
          status: "pending",
        }}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDetails={vi.fn()}
      />,
    );

    expect(screen.getByTestId("specialist-pending-consent-duration")).toHaveTextContent(
      "For 3 days.",
    );
  });

  it("reads a string duration off the wire and stays quiet when there is none", () => {
    const { unmount } = render(
      <SpecialistPendingConsentRequestCard
        item={{
          id: "req_duration_string",
          requesterLabel: "Macy's",
          scope: "attr.profile.city",
          expiryHours: "24",
          status: "pending",
        }}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDetails={vi.fn()}
      />,
    );
    expect(screen.getByTestId("specialist-pending-consent-duration")).toHaveTextContent(
      "For 1 day.",
    );
    unmount();

    render(
      <SpecialistPendingConsentRequestCard
        item={{
          id: "req_no_duration",
          requesterLabel: "Macy's",
          scope: "attr.profile.city",
          expiryHours: null,
          status: "pending",
        }}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDetails={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("specialist-pending-consent-duration")).toBeNull();
  });

  it("arms Deny on the first tap and only denies on the second", () => {
    vi.useFakeTimers();
    const onDeny = vi.fn();
    const item = {
      id: "req_armed",
      requesterLabel: "Macy's",
      scope: "attr.profile.city",
      status: "pending",
    } as const;

    render(
      <SpecialistPendingConsentRequestCard
        item={item}
        onApprove={vi.fn()}
        onDeny={onDeny}
        onDetails={vi.fn()}
      />,
    );

    const deny = screen.getByTestId("specialist-pending-consent-deny");
    expect(deny).toHaveTextContent("Deny");
    expect(deny.getAttribute("aria-label")).toBe("Deny (tap again to confirm)");

    fireEvent.click(deny);
    expect(onDeny).not.toHaveBeenCalled();
    expect(deny).toHaveTextContent("Sure?");
    expect(deny.getAttribute("aria-label")).toBe("Confirm Deny");
    expect(deny.getAttribute("data-armed")).toBe("true");

    fireEvent.click(deny);
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledWith(item);
    expect(deny).toHaveTextContent("Deny");
    expect(deny.getAttribute("data-armed")).toBeNull();
  });

  it("disarms Deny on its own if the second tap never comes", () => {
    vi.useFakeTimers();
    const onDeny = vi.fn();

    render(
      <SpecialistPendingConsentRequestCard
        item={{
          id: "req_disarm",
          requesterLabel: "Macy's",
          scope: "attr.profile.city",
          status: "pending",
        }}
        onApprove={vi.fn()}
        onDeny={onDeny}
        onDetails={vi.fn()}
      />,
    );

    const deny = screen.getByTestId("specialist-pending-consent-deny");
    fireEvent.click(deny);
    expect(deny).toHaveTextContent("Sure?");

    act(() => {
      vi.advanceTimersByTime(3400);
    });
    expect(deny).toHaveTextContent("Sure?");

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(deny).toHaveTextContent("Deny");
    expect(deny.getAttribute("aria-label")).toBe("Deny (tap again to confirm)");

    // A tap after the window arms again rather than denying.
    fireEvent.click(deny);
    expect(onDeny).not.toHaveBeenCalled();
    expect(deny).toHaveTextContent("Sure?");
  });

  it.each([
    ["approved", "Approved"], ["denied", "Denied"], ["cancelled", "Withdrawn"],
    ["expired", "Expired"], ["revoked", "Revoked"], ["unavailable", "Status unavailable"],
  ] as const)("renders %s requests without approve or deny actions", (status, label) => {
    const item = {
      id: "req_approved",
      requesterLabel: "Chase",
      scope: "attr.profile.city",
      scopeDescription: "City",
      status,
    } as const;

    render(
      <SpecialistPendingConsentRequestCard
        item={item}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDetails={vi.fn()}
      />,
    );

    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByTestId("specialist-pending-consent-approve")).toBeNull();
    expect(screen.queryByTestId("specialist-pending-consent-deny")).toBeNull();
    expect(screen.getByTestId("specialist-pending-consent-details")).toBeTruthy();
  });

  it("fails closed for an unknown status", () => {
    render(<SpecialistPendingConsentRequestCard
      item={{id: "request", requesterLabel: "Alex", scope: "attr.profile.city",
        status: "unexpected" as never}}
      onApprove={vi.fn()} onDeny={vi.fn()} onDetails={vi.fn()} />);
    expect(screen.getByText("Status unavailable")).toBeTruthy();
    expect(screen.queryByTestId("specialist-pending-consent-approve")).toBeNull();
    expect(screen.queryByTestId("specialist-pending-consent-deny")).toBeNull();
  });

  it("disarms Deny when status becomes terminal", () => {
    const item = {id: "request", requesterLabel: "Alex", scope: "attr.profile.city"};
    const actions = {onApprove: vi.fn(), onDeny: vi.fn(), onDetails: vi.fn()};
    const {rerender} = render(<SpecialistPendingConsentRequestCard item={item} {...actions} />);
    fireEvent.click(screen.getByTestId("specialist-pending-consent-deny"));
    expect(screen.getByTestId("specialist-pending-consent-deny")).toHaveTextContent("Sure?");
    rerender(<SpecialistPendingConsentRequestCard item={{...item, status: "expired"}} {...actions} />);
    expect(screen.queryByTestId("specialist-pending-consent-deny")).toBeNull();
    rerender(<SpecialistPendingConsentRequestCard item={item} {...actions} />);
    expect(screen.getByTestId("specialist-pending-consent-deny")).toHaveTextContent("Deny");
    expect(actions.onDeny).not.toHaveBeenCalled();
  });
});
