import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CalendarJoinLink } from "@/components/calendar/calendar-join-link";

describe("Calendar-scoped Join", () => {
  it("opens the clicked event as its connected account and lets Google choose another session", () => {
    const url = "https://meet.google.com/meet/abc-defg-hij?foo=bar&authuser=0#details";
    const hintedUrl = "https://meet.google.com/meet/abc-defg-hij?foo=bar&authuser=account-b%40example.com#details";
    const view = render(<CalendarJoinLink url={url} accountEmail="account-b@example.com" />);
    const join = screen.getByRole("link", { name: "Join meeting" });
    expect(join).toHaveAttribute("href", hintedUrl);
    fireEvent.click(join);
    const dialog = screen.getByRole("dialog", { name: "Check Google account" });
    expect(within(dialog).getByText(/Use account-b@example.com in Google Meet/)).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Open Meet" })).toHaveAttribute("href", hintedUrl);
    const chooser = new URL((within(dialog).getByRole("link", { name: "Choose account" }) as HTMLAnchorElement).href);
    expect(chooser.origin + chooser.pathname).toBe("https://accounts.google.com/AccountChooser");
    expect(chooser.searchParams.get("continue")).toBe("https://meet.google.com/meet/abc-defg-hij?foo=bar#details");
    view.rerender(<CalendarJoinLink url="https://meet.google.com/xyz-wxyz-xyz" accountEmail="account-c@example.com" />);
    expect(within(dialog).getByRole("link", { name: "Open Meet" })).toHaveAttribute("href", hintedUrl);
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
    const lookalike = screen.getByRole("link", { name: "Join meeting" });
    expect(lookalike).toHaveAttribute("href", "https://meet.google.com.evil.example/abc-defg-hij");
    fireEvent.click(lookalike);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("rejects credential-bearing and non-HTTPS destinations", () => {
    const view = render(<CalendarJoinLink url="https://person:secret@meet.google.com/abc-defg-hij" accountEmail="private@example.com" />);
    expect(screen.queryByRole("link")).toBeNull();
    view.rerender(<CalendarJoinLink url="javascript:alert(1)" accountEmail="private@example.com" />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
