// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { describe, expect, it, vi } from "vitest";

import { SmsContactsFlow } from "@/components/one-location/redesign/sms-contacts-flow";
import type { OneLocationRecipient } from "@/lib/one-location/types";

const recipients: OneLocationRecipient[] = [
  {
    userId: "selected",
    displayName: "Kushal",
    maskedPhone: "•••• 303",
    phoneVerified: true,
    keyId: "key-selected",
    publicKeyJwk: { kty: "EC" },
    keyAlgorithm: "fixture",
    canReceiveLocation: true,
  },
  {
    userId: "available",
    displayName: "Neelesh",
    maskedPhone: "•••• 404",
    phoneVerified: true,
    keyId: "key-available",
    publicKeyJwk: { kty: "EC" },
    keyAlgorithm: "fixture",
    canReceiveLocation: true,
  },
];

const baseProps = {
  recipients,
  circles: [
    {
      id: "circle-1",
      name: "Family",
      kind: "family" as const,
      role: "owner" as const,
      memberCount: 3,
      memberLimit: 20,
    },
  ],
  selectedUserIds: ["selected"],
  busyKey: null,
  onBack: vi.fn(),
  onAdd: vi.fn(),
  onAddCircle: vi.fn().mockResolvedValue(undefined),
  onRemove: vi.fn(),
  recipientLabel: (recipient: OneLocationRecipient) => recipient.displayName,
  recipientSubtitle: (recipient: OneLocationRecipient) =>
    recipient.maskedPhone || "Connected",
  isRecipientShareReady: (recipient: OneLocationRecipient) =>
    recipient.canReceiveLocation,
  onShareCircleCode: vi.fn().mockResolvedValue(undefined),
  onLoadCircleEligibleConnections: vi.fn().mockResolvedValue({
    eligibleConnections: [],
    pendingInvites: [],
    remainingCapacity: 0,
  }),
  onInviteCircleConnections: vi.fn().mockResolvedValue(undefined),
  onCancelCircleMemberInvite: vi.fn().mockResolvedValue(undefined),
};


describe("SmsContactsFlow", () => {
  it("grows past phone width and keeps contacts in one calm column", () => {
    // The column used to be pinned at 430px at every size, so a tablet or a
    // desktop window rendered a narrow ribbon in a field of grey. Asserting the
    // breakpoint classes is how this file already checks layout, and it is the
    // part a refactor is most likely to drop silently.
    render(<SmsContactsFlow {...baseProps} />);

    const column = screen.getByTestId("sms-contacts-screen")
      .firstElementChild as HTMLElement;
    expect(column).toHaveClass("max-w-[430px]");
    expect(column).toHaveClass("md:max-w-[680px]", "xl:max-w-[720px]");

    // SMS contacts are a simple contact-management task. A forced two-column
    // desktop split made the page feel scattered.
    const lists = screen.getByText("Contacts").closest("div")
      ?.parentElement as HTMLElement;
    expect(lists).toHaveClass("grid", "gap-6");
    expect(lists).not.toHaveClass("md:grid-cols-2");
  });

  it("separates selected and available circle members", () => {
    render(<SmsContactsFlow {...baseProps} />);

    expect(screen.getByText("Contacts")).toBeInTheDocument();
    expect(screen.getByText("Add contacts")).toBeInTheDocument();
    expect(screen.getByText("Kushal")).toBeInTheDocument();
    expect(screen.getByText("Neelesh")).toBeInTheDocument();
  });

  it("adds an available recipient", () => {
    const onAdd = vi.fn();
    render(<SmsContactsFlow {...baseProps} onAdd={onAdd} />);

    fireEvent.click(screen.getByRole("button", { name: "Add Neelesh" }));
    expect(onAdd).toHaveBeenCalledWith("available");
  });

  it("adds the current ready members from an explicitly selected Circle", () => {
    const onAddCircle = vi.fn().mockResolvedValue(undefined);
    render(
      <SmsContactsFlow {...baseProps} onAddCircle={onAddCircle} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add Family" }));

    expect(onAddCircle).toHaveBeenCalledWith("circle-1");
    expect(screen.getByText("3 members")).toBeInTheDocument();
  });

  it("requires confirmation and waits for successful removal", async () => {
    const onRemove = vi.fn().mockResolvedValue(true);
    render(<SmsContactsFlow {...baseProps} onRemove={onRemove} />);

    const removeButton = screen.getByRole("button", { name: "Remove" });
    expect(removeButton).toHaveClass(
      "bg-[color:var(--app-destructive)]/10",
      "text-[color:var(--app-destructive)]",
    );
    fireEvent.click(removeButton);
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByText("Remove Kushal?")).toBeInTheDocument();

    const title = screen.getByRole("heading", { name: /Remove Kushal\?/i });
    expect(title.querySelector("span")).toHaveClass("text-foreground");
    expect(
      screen.getByText("They won't receive SMS alerts."),
    ).toHaveClass("!text-muted-foreground");

    const removeButtons = screen.getAllByRole("button", {
      name: "Remove",
      hidden: true,
    });
    fireEvent.click(removeButtons[removeButtons.length - 1]!);
    await waitFor(() => {
      expect(onRemove).toHaveBeenCalledWith("selected");
      expect(screen.queryByText("Remove Kushal?")).not.toBeInTheDocument();
    });
  });

  it("keeps the confirmation open when removal fails", async () => {
    const onRemove = vi.fn().mockResolvedValue(false);
    render(<SmsContactsFlow {...baseProps} onRemove={onRemove} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const removeButtons = screen.getAllByRole("button", {
      name: "Remove",
      hidden: true,
    });
    fireEvent.click(removeButtons[removeButtons.length - 1]!);

    await waitFor(() => expect(onRemove).toHaveBeenCalledWith("selected"));
    expect(screen.getByText("Remove Kushal?")).toBeInTheDocument();
  });

  it("renders inside the shell and confirms removal in a bottom sheet", () => {
    render(
      <SmsContactsFlow
        {...baseProps}
        onRemove={vi.fn().mockResolvedValue(true)}
      />,
    );

    // It used to pin itself over the whole viewport, which hid the top bar's
    // back control, "Location › SMS contacts" trail and profile avatar, and
    // forced this screen to draw its own back arrow.
    const screenEl = screen.getByTestId("sms-contacts-screen");
    expect(screenEl.className).not.toMatch(/\bfixed\b/);
    expect(screenEl.className).not.toMatch(/\binset-0\b/);
    expect(screenEl.className).not.toMatch(/\bz-\[/);
    expect(screenEl.className).not.toMatch(/100dvh/);

    // Back belongs to the top bar; this screen exposes none of its own.
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();

    // The title comes from the shared header primitive, matching its crumb.
    expect(
      screen.getByRole("heading", { level: 1, name: "SMS contacts" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByRole("alertdialog")).toHaveClass(
      "!bottom-0",
      "!top-auto",
      "!max-w-[430px]",
      "!rounded-t-[24px]",
    );
  });

  it("keeps Circle growth off this screen", () => {
    // This screen answers one question: who gets the alert. A per-Circle
    // "Invite people / Share code" block for every Circle pushed the contact
    // lists below the fold and mixed a membership task into a contact-picking
    // one. Growing a Circle belongs to the People tab, which owns membership.
    render(<SmsContactsFlow {...baseProps} />);

    expect(
      screen.queryByTestId("sms-circle-grow-actions-circle-1"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/^Grow /)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Invite people/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Share code/i }),
    ).not.toBeInTheDocument();

    // The contact lists it exists for are untouched.
    expect(screen.getByText("Circles")).toBeInTheDocument();
  });
});
