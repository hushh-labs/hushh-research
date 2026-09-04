// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { describe, expect, it, vi } from "vitest";

import { SmsContactsFlow } from "@/components/one-location/redesign/sms-contacts-flow";
import type { CircleRecipientSelection } from "@/lib/one-location/circle-recipient-selection";
import type {
  OneLocationCircleMember,
  OneLocationCircleSummary,
  OneLocationRecipient,
} from "@/lib/one-location/types";

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
    connectedFromContacts: true,
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

function member(
  userId: string,
  displayName: string,
): OneLocationCircleMember {
  return {
    userId,
    displayName,
    role: "member",
    status: "active",
    phoneVerified: true,
    canReceiveLocation: true,
    keyId: `key-${userId}`,
    publicKeyJwk: { kty: "EC" },
  } as OneLocationCircleMember;
}

/** A resolved Circle roster: two people ready, one held back with a reason. */
function circleSelection(
  ready: Array<{ userId: string; displayName: string }>,
): CircleRecipientSelection {
  return {
    circle: {
      id: "circle-1",
      name: "Family",
      kind: "family",
      role: "owner",
      memberCount: ready.length + 1,
      memberLimit: 100,
      members: ready.map((person) => member(person.userId, person.displayName)),
    },
    ready: ready.map((person) => ({
      sourceCircleId: "circle-1",
      recipient: {
        userId: person.userId,
        displayName: person.displayName,
        phoneVerified: true,
        keyId: `key-${person.userId}`,
        publicKeyJwk: { kty: "EC" },
        keyAlgorithm: "fixture",
        canReceiveLocation: true,
        connectedFromContacts: person.userId === "aarav",
      },
    })),
    excluded: [
      {
        member: member("not-ready", "Priya"),
        reason: "location_setup_needed",
        label: "Location setup is not complete",
      },
    ],
  } as CircleRecipientSelection;
}

const baseProps = {
  recipients,
  circles: [
    {
      id: "circle-1",
      name: "Family",
      kind: "family" as const,
      role: "owner" as const,
      memberCount: 3,
      memberLimit: 100,
    },
  ],
  selectedUserIds: ["selected"],
  busyKey: null,
  onAdd: vi.fn(),
  onAddCircleMembers: vi.fn().mockResolvedValue(undefined),
  onLoadCircleMembers: vi
    .fn()
    .mockResolvedValue(
      circleSelection([
        { userId: "aarav", displayName: "Aarav Shah" },
        { userId: "maya", displayName: "Maya Chen" },
      ]),
    ),
  onRemove: vi.fn(),
  recipientLabel: (recipient: OneLocationRecipient) => recipient.displayName,
  recipientSubtitle: (recipient: OneLocationRecipient) =>
    recipient.maskedPhone || "Connected",
  isRecipientShareReady: (recipient: OneLocationRecipient) =>
    recipient.canReceiveLocation,
};

/** The flat directory lives behind the second tab now. */
function openAllContacts() {
  fireEvent.click(screen.getByRole("tab", { name: "All Contacts" }));
}

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
  });

  it("presents exactly two sections: Circles and All Contacts", () => {
    render(<SmsContactsFlow {...baseProps} />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Circles",
      "All Contacts",
    ]);
    // "Add contacts" named the button on each row rather than the list, which
    // left the screen holding a "Contacts" list and an "Add contacts" list that
    // were the same people in two states.
    expect(screen.queryByText("Add contacts")).not.toBeInTheDocument();

    expect(screen.getByTestId("sms-circles-panel")).toBeInTheDocument();
    openAllContacts();
    expect(screen.getByTestId("sms-all-contacts-panel")).toBeInTheDocument();
    expect(screen.getByText("Kushal")).toBeInTheDocument();
    expect(screen.getByText("Neelesh")).toBeInTheDocument();
  });

  it("never exposes the auto-managed Trusted Circle as an emergency SMS bulk source", () => {
    const circles: OneLocationCircleSummary[] = [
      {
        id: "trusted-circle",
        name: "Trusted",
        kind: "other",
        role: "owner",
        memberCount: 5000,
        memberLimit: null,
        systemKind: "trusted",
      },
      {
        id: "family-circle",
        name: "Family",
        kind: "family",
        role: "owner",
        memberCount: 3,
        memberLimit: 100,
        systemKind: null,
      },
      {
        id: "sms-circle",
        name: "SMS Circle",
        kind: "other",
        role: "owner",
        memberCount: 4,
        memberLimit: 100,
        isSystem: true,
        systemKind: "sms",
      },
    ];

    render(<SmsContactsFlow {...baseProps} circles={circles} />);

    expect(screen.queryByText("Trusted")).not.toBeInTheDocument();
    expect(screen.getByText("Family")).toBeInTheDocument();
    expect(screen.getByText("SMS Circle")).toBeInTheDocument();
  });

  it("opens on All Contacts when the account has no Circles", () => {
    // Landing on an empty tab makes the screen look broken before the person
    // has done anything.
    render(<SmsContactsFlow {...baseProps} circles={[]} />);

    expect(screen.getByTestId("sms-all-contacts-panel")).toBeInTheDocument();
  });

  it("adds an available recipient", () => {
    const onAdd = vi.fn();
    render(<SmsContactsFlow {...baseProps} onAdd={onAdd} />);

    openAllContacts();
    fireEvent.click(screen.getByRole("button", { name: "Add Neelesh" }));
    expect(onAdd).toHaveBeenCalledWith("available");
  });

  it("identifies contact-synced people in the directory and review sheet", async () => {
    render(<SmsContactsFlow {...baseProps} />);

    openAllContacts();
    expect(
      screen.getByLabelText("Connected from your contacts"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("sms-selected-pill"));
    const sheet = await screen.findByTestId("sms-selected-sheet");
    expect(
      within(sheet).getByLabelText("Connected from your contacts"),
    ).toBeInTheDocument();
  });

  describe("per-Circle person picker", () => {
    it("picks individual members instead of taking the whole Circle", async () => {
      // The reported gap: a Circle offered one "Add" that took every member.
      // Tolerable at 20; not at 100.
      const onAddCircleMembers = vi.fn().mockResolvedValue(undefined);
      render(
        <SmsContactsFlow
          {...baseProps}
          onAddCircleMembers={onAddCircleMembers}
        />,
      );

      // Collapsed, the row is an expander -- not an all-or-nothing Add.
      expect(
        screen.queryByRole("button", { name: "Add Family" }),
      ).not.toBeInTheDocument();
      // Circle counts consistently exclude the person viewing the Circle.
      expect(screen.getByText("2 members")).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole("button", { name: "Choose people from Family" }),
      );

      const list = await screen.findByTestId("circle-members-circle-1");
      fireEvent.click(
        within(list).getByRole("checkbox", { name: "Aarav Shah" }),
      );

      fireEvent.click(screen.getByTestId("circle-add-selected-circle-1"));
      await waitFor(() => {
        expect(onAddCircleMembers).toHaveBeenCalledWith("circle-1", ["aarav"]);
      });
      // Only the ticked person, never the roster.
      expect(onAddCircleMembers).not.toHaveBeenCalledWith("circle-1", [
        "aarav",
        "maya",
      ]);
      expect(
        within(list).getByLabelText("Connected from your contacts"),
      ).toBeInTheDocument();
    });

    it("resolves the roster only when the Circle is opened", async () => {
      // Ten collapsed Circles must not cost ten roster requests.
      const onLoadCircleMembers = baseProps.onLoadCircleMembers;
      onLoadCircleMembers.mockClear();
      render(<SmsContactsFlow {...baseProps} />);

      expect(onLoadCircleMembers).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole("button", { name: "Choose people from Family" }),
      );
      await waitFor(() =>
        expect(onLoadCircleMembers).toHaveBeenCalledWith("circle-1"),
      );
    });

    it("names members it cannot add rather than dropping them silently", async () => {
      render(<SmsContactsFlow {...baseProps} />);

      fireEvent.click(
        screen.getByRole("button", { name: "Choose people from Family" }),
      );

      // Someone hunting for a person who is not there needs to know they were
      // found and skipped, not silently absent.
      expect(await screen.findByText("Priya")).toBeInTheDocument();
      expect(
        screen.getByText("Location setup is not complete"),
      ).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: "Priya" })).toBeDisabled();
    });

    it("selects and clears every addable member at once", async () => {
      const onAddCircleMembers = vi.fn().mockResolvedValue(undefined);
      render(
        <SmsContactsFlow
          {...baseProps}
          onAddCircleMembers={onAddCircleMembers}
        />,
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Choose people from Family" }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Select all 2" }));
      fireEvent.click(screen.getByTestId("circle-add-selected-circle-1"));

      await waitFor(() => {
        expect(onAddCircleMembers).toHaveBeenCalledWith("circle-1", [
          "aarav",
          "maya",
        ]);
      });
    });
  });

  describe("conditional list controls", () => {
    it("hides search and sort while a list still fits on one screen", () => {
      render(<SmsContactsFlow {...baseProps} />);

      openAllContacts();
      // Two contacts. A search field here is furniture, not help.
      expect(
        screen.queryByTestId("contact-list-controls"),
      ).not.toBeInTheDocument();
    });

    it("reveals them once the list outgrows a screenful, and filters on it", () => {
      const many: OneLocationRecipient[] = Array.from({ length: 24 }, (_, i) => ({
        ...recipients[1]!,
        userId: `person-${i}`,
        displayName: i === 7 ? "Zubin Mehta" : `Person ${i}`,
      }));
      render(
        <SmsContactsFlow {...baseProps} recipients={many} selectedUserIds={[]} />,
      );

      openAllContacts();
      expect(screen.getByTestId("contact-list-controls")).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText("Search contacts"), {
        target: { value: "zubin" },
      });
      expect(screen.getByText("Zubin Mehta")).toBeInTheDocument();
      expect(screen.queryByText("Person 3")).not.toBeInTheDocument();

      // The defect this guards: measuring the FILTERED list would unmount the
      // field the moment it narrowed below the threshold, which clears the
      // query, which regrows the list, which remounts the field.
      expect(screen.getByTestId("contact-list-controls")).toBeInTheDocument();
    });
  });

  describe("review pill and sheet", () => {
    it("counts the added people and opens a sheet listing them", async () => {
      render(<SmsContactsFlow {...baseProps} />);

      const pill = screen.getByTestId("sms-selected-pill");
      expect(pill).toHaveTextContent("1 person added");

      fireEvent.click(pill);
      const sheet = await screen.findByTestId("sms-selected-sheet");
      // Only the people actually added, from either tab.
      expect(within(sheet).getByText("Kushal")).toBeInTheDocument();
      expect(within(sheet).queryByText("Neelesh")).not.toBeInTheDocument();
    });

    it("reads under the header and above the tabs, in flow", () => {
      render(<SmsContactsFlow {...baseProps} />);

      const pill = screen.getByTestId("sms-selected-pill");
      const title = screen.getByRole("heading", {
        name: "Emergency contacts",
      });
      const tablist = screen.getByRole("tablist", { name: "Contact sources" });

      // The defect this guards: the pill used to be lifted out of the flow and
      // pinned near the bottom of the screen, which on a list short enough not
      // to scroll left it sitting on top of the first contact row.
      expect(
        title.compareDocumentPosition(pill) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        pill.compareDocumentPosition(tablist) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      // In flow means in flow: no positioning, and no bottom offset left over
      // from the version that floated.
      const anchor = pill.parentElement!;
      expect(anchor.className).not.toMatch(/\b(fixed|sticky|absolute)\b/);
      expect(anchor.style.position).toBe("");
      expect(anchor.style.bottom).toBe("");
    });

    it("renders the pill exactly once", () => {
      render(<SmsContactsFlow {...baseProps} />);

      // Moving it out of the footer slot is only a move if the old one went.
      expect(screen.getAllByTestId("sms-selected-pill")).toHaveLength(1);
    });

    it("shows no pill at all when nobody is added", () => {
      render(<SmsContactsFlow {...baseProps} selectedUserIds={[]} />);

      // A permanent "0 people added" hovering over a screen whose whole job is
      // to stop being 0.
      expect(screen.queryByTestId("sms-selected-pill")).not.toBeInTheDocument();
    });

    it("removes from the sheet through the same confirmation", async () => {
      const onRemove = vi.fn().mockResolvedValue(true);
      render(<SmsContactsFlow {...baseProps} onRemove={onRemove} />);

      fireEvent.click(screen.getByTestId("sms-selected-pill"));
      const sheet = await screen.findByTestId("sms-selected-sheet");
      fireEvent.click(
        within(sheet).getByRole("button", { name: "Remove Kushal" }),
      );

      // Never a silent delete, wherever it is triggered from.
      expect(onRemove).not.toHaveBeenCalled();
      expect(await screen.findByText("Remove Kushal?")).toBeInTheDocument();
    });
  });

  it("requires confirmation and waits for successful removal", async () => {
    const onRemove = vi.fn().mockResolvedValue(true);
    render(<SmsContactsFlow {...baseProps} onRemove={onRemove} />);

    openAllContacts();
    const removeButton = screen.getByRole("button", { name: "Remove Kushal" });
    // The ground is the semantic `-tint` partner, not a one-off alpha on the
    // flat token. Hand-rolled alphas are what made the same destructive ground
    // render a slightly different colour on every screen that spelled it out.
    expect(removeButton).toHaveClass(
      "bg-[color:var(--app-destructive-tint)]",
      "text-[color:var(--app-destructive)]",
    );
    fireEvent.click(removeButton);
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByText("Remove Kushal?")).toBeInTheDocument();

    const title = screen.getByRole("heading", { name: /Remove Kushal\?/i });
    expect(title.querySelector("span")).toHaveClass("text-foreground");
    expect(screen.getByText("They won't receive SMS alerts.")).toHaveClass(
      "!text-muted-foreground",
    );

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

    openAllContacts();
    fireEvent.click(screen.getByRole("button", { name: "Remove Kushal" }));
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
      screen.getByRole("heading", { level: 1, name: "Emergency contacts" }),
    ).toBeInTheDocument();

    openAllContacts();
    fireEvent.click(screen.getByRole("button", { name: "Remove Kushal" }));
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
  });
});
