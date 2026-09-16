import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The word the owner reads for a history event.
 *
 * The backend writes an EXPORT_READ row when the requester opens a live grant.
 * It is an audit record, not a lifecycle transition, and both history
 * surfaces used to humanise it by lowercasing the raw action, which printed
 * "Export read" / "export read": a word the owner never sees. Both now say
 * "Opened". These tests pin the sentence and keep the generic fallback for
 * the actions that already read well.
 */

const mocks = vi.hoisted(() => ({
  getIdToken: vi.fn().mockResolvedValue("id-token"),
  getHandshakeHistory: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: "user-1", getIdToken: mocks.getIdToken },
    loading: false,
  }),
}));

vi.mock("@/lib/services/consent-center-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/services/consent-center-service")>();
  return {
    ...actual,
    ConsentCenterService: {
      ...actual.ConsentCenterService,
      getHandshakeHistory: mocks.getHandshakeHistory,
    },
  };
});

import { formatLifecycleEventLabel } from "@/components/consent/consent-center-page";
import { HandshakeTimeline } from "@/components/consent/handshake-timeline";

describe("Consent Center history event labels", () => {
  it("says Opened for a requester reading a live grant, never the raw action", () => {
    const label = formatLifecycleEventLabel({
      action: "EXPORT_READ",
      status: "opened",
    } as never);
    expect(label).toBe("Opened");
    expect(label).not.toMatch(/export/i);
  });

  it("matches the action regardless of case", () => {
    expect(
      formatLifecycleEventLabel({ action: "export_read" } as never),
    ).toBe("Opened");
  });

  it("still humanises the transitions the fallback already reads well", () => {
    expect(
      formatLifecycleEventLabel({ action: "CONSENT_GRANTED" } as never),
    ).toBe("Consent granted");
    expect(formatLifecycleEventLabel({ action: "REVOKED" } as never)).toBe(
      "Revoked",
    );
    expect(
      formatLifecycleEventLabel({ action: null, status: "approved" } as never),
    ).toBe("Approved");
    expect(formatLifecycleEventLabel({} as never)).toBe("Consent event");
  });
});

describe("HandshakeTimeline action labels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a grant being opened as Opened, never as export read", async () => {
    mocks.getHandshakeHistory.mockResolvedValue({
      timeline: [
        {
          id: "evt-1",
          action: "CONSENT_GRANTED",
          status: "approved",
          scope: "attr.profile.city",
          scope_description: "City",
          issued_at: 1_700_000_000_000,
        },
        {
          id: "evt-2",
          action: "EXPORT_READ",
          status: "opened",
          scope: "attr.profile.city",
          scope_description: "City",
          issued_at: 1_700_000_600_000,
        },
      ],
    });

    render(<HandshakeTimeline counterpartId="agent-1" counterpartLabel="Sharu" />);

    await waitFor(() => expect(screen.getByText("Opened")).toBeTruthy());
    expect(screen.getByText("Consent granted")).toBeTruthy();
    expect(screen.queryByText(/export/i)).toBeNull();
  });
});
