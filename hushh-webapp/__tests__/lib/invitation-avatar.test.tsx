import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InvitationAvatar } from "@/components/calendar/calendar-invitation-detail";

describe("Calendar invitation avatar fallback", () => {
  it("retains its initial when a Google photo fails to load", () => {
    const view = render(<InvitationAvatar name="Manish" email="manish@example.com" photoUrl="https://lh3.googleusercontent.com/broken/photo.jpg" photoSource="google_profile" />);
    const image = view.container.querySelector("img");
    if (image) fireEvent.error(image);
    expect(screen.getByText("M")).toBeTruthy();
    expect(view.container.querySelector('[data-photo-source="google_profile"]')).toBeTruthy();
  });
});
