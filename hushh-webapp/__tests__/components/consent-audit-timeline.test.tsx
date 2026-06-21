import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConsentAuditTimeline } from "@/components/consent/consent-audit-timeline";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";

function renderTimeline(entry: ConsentCenterEntry) {
  return render(
    <ConsentAuditTimeline
      entries={[entry]}
      selectedId={null}
      onSelect={vi.fn()}
      resolveCounterpartLabel={() => "Macy's CRM"}
      summarizeEntry={() => "Recent consent history"}
    />,
  );
}

describe("ConsentAuditTimeline", () => {
  it("renders grouped history as separate lifecycle clusters", () => {
    renderTimeline({
      id: "identifier:macy",
      kind: "history",
      status: "approved",
      action: "CONSENT_GRANTED",
      counterpart_type: "developer",
      counterpart_label: "Macy's CRM",
      issued_at: "2026-06-18T17:30:00.000Z",
      trail_count: 2,
      event_count: 3,
      consent_trails: [
        {
          id: "trail_new",
          scope: "attr.shopping.profile.*",
          scope_description: "Shopping profile",
          status: "approved",
          action: "CONSENT_GRANTED",
          issued_at: "2026-06-18T17:30:00.000Z",
          latest_request_id: "req_new",
          event_count: 2,
          events: [
            {
              id: "event_grant",
              request_id: "req_new",
              status: "approved",
              action: "CONSENT_GRANTED",
              scope_description: "Shopping profile",
              issued_at: "2026-06-18T17:30:00.000Z",
            },
            {
              id: "event_requested",
              request_id: "req_new",
              status: "pending",
              action: "REQUESTED",
              scope_description: "Shopping profile",
              issued_at: "2026-06-18T17:00:00.000Z",
            },
          ],
        },
        {
          id: "trail_old",
          scope: "attr.shopping.receipts.*",
          scope_description: "Receipts",
          status: "revoked",
          action: "REVOKED",
          issued_at: "2026-06-17T12:00:00.000Z",
          latest_request_id: "req_old",
          event_count: 1,
          events: [
            {
              id: "event_revoke",
              request_id: "req_old",
              status: "revoked",
              action: "REVOKED",
              scope_description: "Receipts",
              issued_at: "2026-06-17T12:00:00.000Z",
            },
          ],
        },
      ],
    });

    expect(screen.getByText("Macy's CRM")).toBeTruthy();
    expect(screen.getByText("2 lifecycles")).toBeTruthy();
    expect(screen.getByText("Lifecycle 1")).toBeTruthy();
    expect(screen.getByText("Lifecycle 2")).toBeTruthy();
    expect(screen.getAllByText("Shopping profile").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Receipts").length).toBeGreaterThan(0);
    expect(screen.getByText("Consent granted")).toBeTruthy();
    expect(screen.getByText("Requested")).toBeTruthy();
    expect(screen.getAllByText("Revoked").length).toBeGreaterThan(0);
    expect(screen.queryByText("Activity trails")).toBeNull();
  });
});
