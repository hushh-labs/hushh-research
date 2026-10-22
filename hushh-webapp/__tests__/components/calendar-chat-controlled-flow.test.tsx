import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import results from "../fixtures/calendar-chat-controlled-results.json";
import { getCalendarDirectiveFromToolEvent } from "@/components/agent/agent-chat-workspace";
import { SpecialistDirectiveCard } from "@/components/agent/specialist-directive-card";
import { AgentCalendarProposalCard } from "@/components/agent/agent-calendar-proposal-card";
import { runCalendarDirective } from "@/lib/agent/calendar-directive-runtime";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";
import type { AgentChatToolEvent } from "@/lib/services/agent-chat-client";

// Captured from actual Calendar tool code with controlled, synthetic provider
// adapters. No live credentials or meetings are used by this replay.
function project(result: unknown) {
  return getCalendarDirectiveFromToolEvent({ raw: { toolName: "propose_calendar_event", result } } as AgentChatToolEvent);
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("controlled Calendar tool → visible action → confirmation", () => {
  it.each(["disconnected", "read_only", "expired"] as const)("renders scheduling authorization for %s without executing a meeting", state => {
    const event = project(results[state])!;
    const payload = event.directive.payload;
    expect(payload.type).toBe("calendar.connect");
    expect(payload.accessLevel).toBe("manage");
    const authorize = vi.fn();
    const execute = vi.spyOn(GoogleCalendarService, "executeProposal");
    render(<SpecialistDirectiveCard summary={String(payload.summary)} confirmLabel={String(payload.confirmLabel)} onConfirm={authorize} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow Calendar scheduling" }));
    expect(authorize).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(screen.queryByText("Manage Calendar")).toBeNull();
  });

  it("does not turn a provider error into a reconnect or success action", () => {
    expect(project(results.provider_error)).toBeNull();
    expect(results.provider_error.status).toBe("failed");
  });

  it("shows the next local date and exactly 30 minutes across midnight", () => {
    render(<AgentCalendarProposalCard {...results.write_authorized.directive.payload} action="create" conflicts={[]} startAt="2026-10-16T18:00:00Z" endAt="2026-10-16T18:30:00Z" timeZone="Asia/Kolkata" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/Oct 16.*Oct 17.*30 min/)).toBeVisible();
    expect(screen.queryByText(/29\.98/)).toBeNull();
  });

  it("shows an existing short interval honestly without fractional-minute noise", () => {
    render(<AgentCalendarProposalCard {...results.write_authorized.directive.payload} action="create" conflicts={[]} startAt="2026-10-16T18:00:00Z" endAt="2026-10-16T18:29:59Z" timeZone="Asia/Kolkata" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/29 min 59 sec/)).toBeVisible();
  });

  it("shows details and attendees for sufficient access and executes only the confirmed proposal", async () => {
    const event = project(results.write_authorized)!;
    const payload = results.write_authorized.directive.payload;
    expect(event.directive.payload.type).toBe("calendar.execute_proposal");
    const execute = vi.spyOn(GoogleCalendarService, "executeProposal").mockResolvedValue({
      action: "create", event: { id: "synthetic-confirmed-event", title: "Planning", conference_url: "https://meet.google.com/abc-defg-hij" },
    } as Awaited<ReturnType<typeof GoogleCalendarService.executeProposal>>);
    const result = vi.fn();
    const props = { ...payload, action: "create" as const, conflicts: [], onCancel: vi.fn(), onConfirm: () => { void runCalendarDirective(event.directive, "synthetic-token", "synthetic-owner").then(result); } };
    const view = render(<AgentCalendarProposalCard {...props} />);
    expect(screen.getByText(/person@example\.com/)).toBeVisible();
    expect(screen.getByText("Planning")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Allow Calendar scheduling" })).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Schedule meeting" }));
    view.rerender(<AgentCalendarProposalCard {...props} busy />);
    fireEvent.click(screen.getByRole("button", { name: /Scheduling|Schedule meeting|Working/i }));
    await waitFor(() => expect(result).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledExactlyOnceWith({ vaultOwnerToken: "synthetic-token", userId: "synthetic-owner", proposalId: "gcal_example" });
    expect(result.mock.calls[0][0]).toMatchObject({ status: "completed", type: "calendar.create" });
  });
});
