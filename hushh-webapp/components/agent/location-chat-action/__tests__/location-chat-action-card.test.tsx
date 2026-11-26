import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LocationChatActionCard } from "../location-chat-action-card";

describe("LocationChatActionCard", () => {
  it("keeps same-name matches distinguishable and requires a choice before continuing", () => {
    const confirm = vi.fn();
    render(<LocationChatActionCard model={{
      phase: "review",
      title: "Who should receive your location?",
      choices: [
        { id: "first", label: "Riley Chen", detail: "Design" },
        { id: "second", label: "Riley Chen", detail: "Running club" },
      ],
      confirmLabel: "Continue",
    }} onConfirm={confirm} />);

    const continueButton = screen.getByRole("button", { name: "Continue" });
    fireEvent.click(continueButton);
    expect(confirm).not.toHaveBeenCalled();

    const match = screen.getByRole("radio", { name: "Riley Chen", description: "Running club" });
    fireEvent.click(match);
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(continueButton);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ choiceId: "second" }), expect.anything());
  });

  it("previews extra time from the existing end and confirms the added amount", () => {
    const confirm = vi.fn();
    render(<LocationChatActionCard model={{
      phase: "review",
      title: "Add time to your live location share",
      subject: { label: "Riley Chen" },
      duration: {
        kind: "extension",
        minutes: 30,
        options: [30, 60],
        currentEndAt: "2026-11-30T23:45:00Z",
        proposedEndAt: "2026-12-01T00:15:00Z",
      },
      confirmLabel: "Add time",
    }} onConfirm={confirm} />);

    const currentEnd = screen.getByText("Current end").nextElementSibling?.querySelector("time");
    const newEnd = screen.getByText("New end").nextElementSibling?.querySelector("time");
    expect(currentEnd).toHaveAttribute("datetime", "2026-11-30T23:45:00.000Z");
    expect(newEnd).toHaveAttribute("datetime", "2026-12-01T00:15:00.000Z");
    fireEvent.click(screen.getByRole("radio", { name: "1 hour" }));
    expect(newEnd).toHaveAttribute("datetime", "2026-12-01T00:45:00.000Z");
    fireEvent.click(screen.getByRole("button", { name: "Add time" }));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ durationMinutes: 60, durationMode: "timed" }), expect.anything());
  });

  it("requires a second explicit activation to decline a request", () => {
    const approve = vi.fn();
    const decline = vi.fn();
    render(<LocationChatActionCard model={{
      phase: "review",
      title: "Review Riley’s location request",
      canDecline: true,
      confirmLabel: "Approve",
    }} onConfirm={approve} onDecline={decline} />);

    fireEvent.click(screen.getByRole("button", { name: /decline/i }));
    expect(decline).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /confirm decline/i }));
    expect(decline).toHaveBeenCalledOnce();
    expect(approve).not.toHaveBeenCalled();
  });

  it("removes the map when its share enters recovery", () => {
    const map = <div>Authorized live map</div>;
    const { rerender } = render(<LocationChatActionCard model={{
      phase: "active", mode: "live", title: "Riley’s live location", status: "Sharing live",
    }} map={map} />);
    expect(screen.getByText("Authorized live map")).toBeInTheDocument();

    rerender(<LocationChatActionCard model={{
      phase: "recovery", title: "Location access ended", description: "You can ask Riley to share again.",
    }} map={map} />);
    expect(screen.queryByText("Authorized live map")).not.toBeInTheDocument();
  });
});
