import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SheetPersonRow } from "@/components/app-ui/sheet-parts";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";

const preview = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/lib/connections/person-profile-preview", () => ({
  openPersonProfilePreview: preview.open,
}));

describe("SheetPersonRow", () => {
  beforeEach(() => preview.open.mockClear());

  const row = (onCheckedChange = vi.fn()) => {
    render(
      <SheetPersonRow
        avatar={<ConnectionPersonAvatar userId="user_1" label="Sharu Khan" />}
        name="Sharu Khan"
        checked={false}
        onCheckedChange={onCheckedChange}
        label="Add Sharu Khan to Trusted"
      />,
    );
    return onCheckedChange;
  };

  it("selects on a tap anywhere on the row without opening the profile", () => {
    const select = row();
    fireEvent.click(screen.getByText("Sharu Khan"));
    expect(select).toHaveBeenCalledWith(true);
    expect(preview.open).not.toHaveBeenCalled();
  });

  it("opens the profile only from the avatar and leaves the selection alone", () => {
    const select = row();
    fireEvent.click(screen.getByRole("button", { name: "View Sharu Khan's profile" }));
    expect(preview.open).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
  });
});
