import { render, within } from "@testing-library/react";
import type { HTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CalendarInvitationDetail } from "@/components/calendar/calendar-invitation-detail";
import type { CalendarInvitation } from "@/lib/services/google-calendar-service";

// Keep the image element visible in JSDOM so this test checks the URL wired to
// each presentation path without relying on a browser image-load event.
vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children, ...props }: HTMLAttributes<HTMLSpanElement>) => <span {...props}>{children}</span>,
  // This test mock needs a raw img to inspect its source without Next image loading.
  // eslint-disable-next-line @next/next/no-img-element
  AvatarImage: ({ src }: { src: string }) => <img src={src} alt="" />,
  AvatarFallback: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

const event: CalendarInvitation = {
  id: "meeting", calendar_id: "owner@example.test", title: "Team Sync",
  start: { dateTime: "2030-10-14T10:00:00Z" }, end: { dateTime: "2030-10-14T10:30:00Z" },
  response_status: "needsAction", can_respond: true, conflicts: [],
  organizer: { email: "organizer@example.test" },
  attendees: [{ email: "manish@example.test", display_name: "Manish", response_status: "accepted" }],
};
const husshPhoto = "https://images.example.test/hussh-manish.png";
const people = new Map([["manish@example.test", { displayName: "Manish", photoUrl: husshPhoto }]]);

describe("invitation photo presentation boundaries", () => {
  it("keeps the Hussh connection photo in Chat while Calendar requires a Google source", () => {
    const chat = render(<CalendarInvitationDetail event={event} zone="UTC" people={people} />);
    expect(chat.container.querySelector(`img[src="${husshPhoto}"]`)).toBeTruthy();
    chat.unmount();

    const workspace = render(<CalendarInvitationDetail event={event} zone="UTC" people={people} workspaceLayout accountEmail="owner@example.test" />);
    const guest = within(workspace.getByRole("list", { name: "Guests" })).getByRole("listitem", { name: /manish/i });
    expect(guest.querySelector("img")).toBeNull();
    expect(guest.textContent).toContain("Manish");
  });
});
