/**
 * The Circle roster's per-member actions, on both surfaces they ship on.
 *
 * The defect these cover was reported with a phone screenshot: the kebab on
 * one member opened an anchored card that painted over the NEXT member's
 * name, so two rows' worth of identity sat under one menu and nothing said
 * which of them the actions belonged to.
 *
 * So the assertions here are about identity and surface, not styling:
 *
 *   - under 640px there is no anchored popper at all, and the surface that
 *     opens names the member it belongs to;
 *   - the destructive step never stacks a second modal over the first;
 *   - at 640px and up the anchored menu still opens, and it too names the
 *     member -- and it closes when the confirm takes over rather than being
 *     left open behind it.
 *
 * `__tests__/setup.ts` stubs `matchMedia` as permanently non-matching, which
 * is the desktop answer; the phone lane restubs it per test.
 */

import type { ComponentProps } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CircleMemberActionsMenu,
  MEMBER_ACTIONS_MENU_TESTID,
  MEMBER_ACTIONS_SHEET_QUERY,
  MEMBER_ACTIONS_SHEET_TESTID,
  memberRemoveConfirmDescription,
  memberRemoveConfirmTitle,
} from "@/components/one-location/redesign/circles/circle-member-actions-menu";

const MEMBER_NAME = "Ankit Kumar Singh";

/** Stubs `matchMedia` so only the sheet boundary answers, and only the way
 *  this test wants it to. Nothing else in the tree reads a media query. */
function setViewport(kind: "phone" | "desktop") {
  const wantsSheet = kind === "phone";
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === MEMBER_ACTIONS_SHEET_QUERY ? wantsSheet : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function renderMenu(
  overrides: Partial<ComponentProps<typeof CircleMemberActionsMenu>> = {},
) {
  const onShare = vi.fn();
  const onRemove = vi.fn(async () => undefined);
  render(
    <CircleMemberActionsMenu
      displayName={MEMBER_NAME}
      initials="AK"
      secondaryLine="Connected"
      canShare
      canRemove
      busy={false}
      onShare={onShare}
      onRemove={onRemove}
      {...overrides}
    />,
  );
  return { onShare, onRemove };
}

const triggerName = `Actions for ${MEMBER_NAME}`;

describe("CircleMemberActionsMenu on a phone", () => {
  beforeEach(() => {
    setViewport("phone");
  });

  it("opens a bottom sheet that names the member instead of an anchored menu over the next row", async () => {
    renderMenu({
      photoUrl: "https://cdn.example.test/ankit-avatar.jpg",
      verified: true,
    });

    fireEvent.click(screen.getByRole("button", { name: triggerName }));

    const sheet = await screen.findByTestId(MEMBER_ACTIONS_SHEET_TESTID);

    // The whole point: nothing is anchored to the row, so nothing can land on
    // the name of the member below it.
    expect(
      document.querySelector("[data-radix-popper-content-wrapper]"),
    ).toBeNull();
    expect(screen.queryByTestId(MEMBER_ACTIONS_MENU_TESTID)).toBeNull();

    // Whose actions these are, said on the surface rather than by proximity.
    expect(within(sheet).getByText(MEMBER_NAME)).toBeInTheDocument();
    expect(within(sheet).getByText("Connected")).toBeInTheDocument();
    expect(
      sheet.querySelector(
        '[data-photo-url="https://cdn.example.test/ankit-avatar.jpg"]',
      ),
    ).toBeTruthy();
    expect(within(sheet).getByLabelText("Verified advisor")).toBeInTheDocument();

    expect(
      within(sheet).getByRole("menuitem", { name: /Share location/i }),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByRole("menuitem", { name: /Remove from Circle/i }),
    ).toBeInTheDocument();
  });

  it("shares with the member and closes the sheet", async () => {
    const { onShare } = renderMenu();

    fireEvent.click(screen.getByRole("button", { name: triggerName }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Share location/i }),
    );

    expect(onShare).toHaveBeenCalledTimes(1);
    // Dismissed on the way out, so the share surface it opens is not raised
    // behind a sheet that is still up. Asserted on the state attribute rather
    // than on unmount: the exit is an animation, and jsdom runs none, so the
    // node lingers in the test DOM long after it is gone on a device.
    await waitFor(() =>
      expect(screen.getByTestId(MEMBER_ACTIONS_SHEET_TESTID)).toHaveAttribute(
        "data-state",
        "closed",
      ),
    );
  });

  it("confirms a removal inside the same sheet rather than stacking a dialog over it", async () => {
    const { onRemove } = renderMenu();

    fireEvent.click(screen.getByRole("button", { name: triggerName }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Remove from Circle/i }),
    );

    // Same surface, second pane -- so there is never a confirm painting
    // underneath the sheet that raised it.
    const sheet = await screen.findByTestId(MEMBER_ACTIONS_SHEET_TESTID);
    expect(
      within(sheet).getByText(memberRemoveConfirmTitle(MEMBER_NAME)),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByText(memberRemoveConfirmDescription(MEMBER_NAME)),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(within(sheet).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(1));
  });

  it("backs out of the confirm without removing anyone", async () => {
    const { onRemove } = renderMenu();

    fireEvent.click(screen.getByRole("button", { name: triggerName }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Remove from Circle/i }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    // Back to the action list, not out of the sheet entirely.
    expect(
      await screen.findByRole("menuitem", { name: /Remove from Circle/i }),
    ).toBeInTheDocument();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("offers only the actions that apply", async () => {
    renderMenu({ canShare: false });

    fireEvent.click(screen.getByRole("button", { name: triggerName }));

    expect(
      await screen.findByRole("menuitem", { name: /Remove from Circle/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /Share location/i }),
    ).toBeNull();
  });
});

describe("CircleMemberActionsMenu on a pointer device", () => {
  beforeEach(() => {
    setViewport("desktop");
  });

  it("keeps the anchored menu", async () => {
    renderMenu();

    const trigger = screen.getByRole("button", { name: triggerName });
    // Radix opens DropdownMenuTrigger on pointerdown (no PointerEvent in
    // jsdom) or on Enter/Space keydown -- use the keyboard path here.
    fireEvent.keyDown(trigger, { key: "Enter" });

    const menu = await screen.findByTestId(MEMBER_ACTIONS_MENU_TESTID);
    expect(screen.queryByTestId(MEMBER_ACTIONS_SHEET_TESTID)).toBeNull();
    expect(
      within(menu).getByRole("menuitem", { name: /Share location/i }),
    ).toBeInTheDocument();
  });

  it("closes the menu when the remove confirm takes over", async () => {
    const { onRemove } = renderMenu();

    fireEvent.keyDown(screen.getByRole("button", { name: triggerName }), {
      key: "Enter",
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Remove from Circle/i }),
    );

    // The menu used to stay open BEHIND the confirm: two surfaces, one
    // decision.
    await waitFor(() =>
      expect(
        screen.queryByRole("menuitem", { name: /Remove from Circle/i }),
      ).toBeNull(),
    );

    expect(
      await screen.findByText(memberRemoveConfirmTitle(MEMBER_NAME)),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove", hidden: true }),
    );
    await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(1));
  });
});

describe("CircleMemberActionsMenu with nothing to offer", () => {
  beforeEach(() => {
    setViewport("phone");
  });

  it("still holds the kebab column open", () => {
    renderMenu({ canShare: false, canRemove: false });

    expect(screen.queryByRole("button", { name: triggerName })).toBeNull();
    const spacer = screen.getByTestId("circle-member-menu-spacer");
    expect(spacer).toHaveAttribute("aria-hidden", "true");
  });
});
