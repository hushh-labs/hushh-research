import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InvitationAvatar } from "@/components/calendar/calendar-invitation-detail";

describe("Calendar invitation avatar fallback", () => {
  it("keeps its initial visible while an admitted HUSSH profile photo is unavailable", () => {
    const view = render(<InvitationAvatar name="Manish" email="manish@example.com" photoUrl="https://lh3.googleusercontent.com/a/broken-photo" />);
    expect(screen.getByText("M")).toBeTruthy();
    expect(view.container.querySelector('[data-photo-source="hussh"]')).toBeTruthy();
  });
});
