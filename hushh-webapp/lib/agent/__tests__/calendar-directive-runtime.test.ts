import { describe, expect, it, vi } from "vitest";

import { runCalendarDirective } from "@/lib/agent/calendar-directive-runtime";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";

vi.mock("@/lib/services/google-calendar-service", () => ({
  GoogleCalendarService: { executeProposal: vi.fn() },
}));

describe("runCalendarDirective", () => {
  it("executes only the proposal id from an explicit calendar confirmation", async () => {
    vi.mocked(GoogleCalendarService.executeProposal).mockResolvedValue({
      action: "create",
      event: { id: "event-1", title: "Planning" },
    });

    const result = await runCalendarDirective(
      {
        kind: "action",
        payload: { type: "calendar.execute_proposal", proposalId: "gcal_example" },
      },
      "HCT:test",
      "user-1",
    );

    expect(GoogleCalendarService.executeProposal).toHaveBeenCalledWith({
      vaultOwnerToken: "HCT:test",
      userId: "user-1",
      proposalId: "gcal_example",
    });
    expect(result).toMatchObject({
      delegate_agent_id: "agent_calendar",
      status: "completed",
      detail: "Scheduled Planning.",
    });
  });

  it("rejects directives that are not a server-persisted calendar proposal", async () => {
    await expect(
      runCalendarDirective(
        { kind: "action", payload: { type: "calendar.create" } },
        "HCT:test",
        "user-1",
      ),
    ).rejects.toThrow("Calendar confirmation is invalid");
    expect(GoogleCalendarService.executeProposal).not.toHaveBeenCalled();
  });
});
