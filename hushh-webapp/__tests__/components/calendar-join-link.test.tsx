import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CalendarJoinLink } from "@/components/calendar/calendar-join-link";

describe("Calendar-scoped Join", () => {
  it("hands the clicked account directly to Google without intercepting navigation", () => {
    const url = "https://meet.google.com/meet/abc-defg-hij?foo=bar&authuser=0#details";
    const view = render(<CalendarJoinLink url={url} accountEmail=" account-b@example.com " />);
    const join = screen.getByRole("link", { name: "Join meeting" });
    const handoff = new URL((join as HTMLAnchorElement).href);
    expect(handoff.origin + handoff.pathname).toBe("https://accounts.google.com/AccountChooser");
    expect(handoff.searchParams.get("Email")).toBe("account-b@example.com");
    expect(handoff.searchParams.get("continue")).toBe("https://meet.google.com/meet/abc-defg-hij?foo=bar&authuser=account-b%40example.com#details");
    expect(join).toHaveAttribute("target", "_blank");
    expect(join).toHaveAttribute("rel", "noopener noreferrer");
    expect(fireEvent.click(join)).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(<CalendarJoinLink url="https://meet.google.com/xyz-wxyz-xyz" accountEmail="account-c@example.com" />);
    const next = new URL((screen.getByRole("link") as HTMLAnchorElement).href);
    expect(next.searchParams.get("Email")).toBe("account-c@example.com");
    expect(next.searchParams.get("continue")).toBe("https://meet.google.com/xyz-wxyz-xyz?authuser=account-c%40example.com");
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
