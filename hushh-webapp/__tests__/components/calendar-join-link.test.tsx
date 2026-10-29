import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CalendarJoinLink } from "@/components/calendar/calendar-join-link";

describe("Calendar-scoped Join", () => {
  it("holds the clicked event's Google account and preserves the exact Meet destination", () => {
    const url = "https://meet.google.com/abc-defg-hij?foo=bar#details";
    const view = render(<CalendarJoinLink url={url} accountEmail="account-b@example.com" />);
    fireEvent.click(screen.getByRole("link", { name: "Join meeting" }));
    const dialog = screen.getByRole("dialog", { name: "Check Google account" });
    expect(within(dialog).getByText(/Use account-b@example.com in Google Meet/)).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Open Meet" })).toHaveAttribute("href", url);
    view.rerender(<CalendarJoinLink url="https://meet.google.com/xyz-wxyz-xyz" accountEmail="account-c@example.com" />);
    expect(within(dialog).getByText(/Use account-b@example.com in Google Meet/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("link", { name: "Join meeting" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Use account-c@example.com in Google Meet");
  });

  it("opens the verified Meet URL without claiming an account when the event account is unavailable", () => {
    render(<CalendarJoinLink url="https://meet.google.com/abc-defg-hij" accountEmail={null} />);
    const join = screen.getByRole("link", { name: "Join meeting" });
    expect(join).toHaveAttribute("href", "https://meet.google.com/abc-defg-hij");
    fireEvent.click(join);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("launches other providers and Meet lookalikes without a Google account hint", () => {
    const view = render(<CalendarJoinLink url="https://discord.com/channels/123456/987654" accountEmail="private@example.com" />);
    expect(screen.getByRole("link", { name: "Join meeting" })).toHaveAttribute("href", "https://discord.com/channels/123456/987654");
    fireEvent.click(screen.getByRole("link", { name: "Join meeting" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(<CalendarJoinLink url="https://meet.google.com.evil.example/abc-defg-hij" accountEmail="private@example.com" />);
    fireEvent.click(screen.getByRole("link", { name: "Join meeting" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("rejects credential-bearing and non-HTTPS destinations", () => {
    const view = render(<CalendarJoinLink url="https://person:secret@meet.google.com/abc-defg-hij" accountEmail="private@example.com" />);
    expect(screen.queryByRole("link")).toBeNull();
    view.rerender(<CalendarJoinLink url="javascript:alert(1)" accountEmail="private@example.com" />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
