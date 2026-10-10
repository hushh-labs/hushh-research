import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/google-calendar-service", () => ({
  GoogleCalendarService: { executeProposal: vi.fn() },
}));

vi.mock("@/lib/services/todo-list-pkm-service", () => ({
  calendarTodoInput: vi.fn(),
  createTodo: vi.fn(),
}));

import { runCalendarDirective } from "@/lib/agent/calendar-directive-runtime";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";
import {
  calendarTodoInput,
  createTodo,
} from "@/lib/services/todo-list-pkm-service";

const directive = {
  kind: "action" as const,
  payload: {
    type: "calendar.execute_proposal",
    proposalId: "gcal_example",
  },
};

describe("runCalendarDirective", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes only the proposal id from an explicit calendar confirmation", async () => {
    vi.mocked(GoogleCalendarService.executeProposal).mockResolvedValue({
      action: "create",
      event: { id: "event-1", title: "Planning" },
    });

    const result = await runCalendarDirective(directive, "HCT:test", "user-1");

    expect(GoogleCalendarService.executeProposal).toHaveBeenCalledWith({
      vaultOwnerToken: "HCT:test",
      userId: "user-1",
      proposalId: "gcal_example",
    });
    expect(createTodo).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      delegate_agent_id: "agent_calendar",
      status: "completed",
      detail:
        "Scheduled Planning. Google Meet is being added to the Calendar invite.",
    });
  });

  it("creates an encrypted automatic item only after Calendar confirms a booking", async () => {
    vi.mocked(GoogleCalendarService.executeProposal).mockResolvedValue({
      action: "create",
      event: {
        id: "event-1",
        title: "Planning",
        start: { dateTime: "2026-10-08T20:30:00+05:30" },
        conference_url: "https://meet.google.com/abc-defg-hij",
      },
    });
    vi.mocked(calendarTodoInput).mockReturnValue({
      id: "calendar_event-1",
      title: "Planning",
      type: "automatic",
      source: "calendar",
      sourceId: "event-1",
      date: "2026-10-08",
      time: "20:30",
      link: "https://meet.google.com/abc-defg-hij",
    });
    vi.mocked(createTodo).mockResolvedValue({
      task: {} as never,
      result: { success: true, saveState: "saved", fullBlob: {} },
    });

    const result = await runCalendarDirective(
      directive,
      "HCT:test",
      "user-1",
      "vault-key",
    );

    expect(calendarTodoInput).toHaveBeenCalledWith({
      id: "event-1",
      title: "Planning",
      start: { dateTime: "2026-10-08T20:30:00+05:30" },
      conference_url: "https://meet.google.com/abc-defg-hij",
    });
    expect(createTodo).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "calendar_event-1",
        source: "calendar",
        sourceId: "event-1",
      }),
      {
        userId: "user-1",
        vaultKey: "vault-key",
        vaultOwnerToken: "HCT:test",
      },
    );
    expect(result.detail).toBe(
      "Scheduled Planning with a Google Meet link. It is ready in the Calendar invite. It is also in your To-do list.",
    );
  });

  it("reports the Meet link only after Calendar returns it", async () => {
    vi.mocked(GoogleCalendarService.executeProposal).mockResolvedValue({
      action: "create",
      event: {
        id: "event-1",
        title: "Planning",
        conference_url: "https://meet.google.com/abc-defg-hij",
      },
    });

    const result = await runCalendarDirective(directive, "HCT:test", "user-1");

    expect(result.detail).toBe(
      "Scheduled Planning with a Google Meet link. It is ready in the Calendar invite.",
    );
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
