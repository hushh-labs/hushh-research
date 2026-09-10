import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContactInvitationSheet as InvitationSheet } from "@/components/connections/contact-invitation-sheet";
import { useInvitationQueue } from "@/lib/contacts/use-invitation-queue";
import type { ContactInvitationController } from "@/lib/contacts/use-contact-invitations";
import type { InviteCandidate } from "@/lib/contacts/invitation-candidates";

const mocks = vi.hoisted(() => ({
  compose: vi.fn(),
  share: vi.fn(),
  copy: vi.fn(),
  canComposeSms: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/services/contact-invitations-service", () => ({
  invitationBody: (share: { text: string; url: string }) =>
    `${share.text}\n${share.url}`,
  ContactInvitationsService: {
    ...mocks,
    isNative: () => true,
    canComposeSms: mocks.canComposeSms,
    completesRecipient: (outcome: string) =>
      ["queued_or_sent", "native-share", "web-share"].includes(outcome),
  },
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toast } }));

type TestController = Omit<ContactInvitationController, "draft">;
function ContactInvitationSheet({
  controller: state,
  onFinish,
}: {
  controller: TestController;
  onFinish: () => void;
}) {
  const draft = useInvitationQueue(
    state.candidates,
    state.share,
    state.captureSession,
  );
  return (
    <InvitationSheet controller={{ ...state, draft }} onFinish={onFinish} />
  );
}

const person = (
  id: string,
  value = `+14155550${id.padStart(3, "0")}`,
): InviteCandidate => ({
  id,
  displayName: `Person ${id}`,
  classification: "no_match",
  destinations: [{ kind: "phone", value }],
});
function controller(candidates: InviteCandidate[]): TestController {
  return {
    enabled: true,
    version: 1,
    active: true,
    candidates,
    clear: vi.fn(),
    beginSync: vi.fn(),
    open: vi.fn(),
    retryPreparation: vi.fn(),
    captureSession: vi.fn(() => () => true),
    preparing: false,
    error: null,
    share: {
      title: "Join One",
      text: "Join me on One.",
      url: "https://one.example/r/inviter",
      dialogTitle: "Invite to One",
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.compose.mockResolvedValue("cancelled");
  mocks.copy.mockResolvedValue("copied");
  mocks.share.mockResolvedValue("native-share");
  mocks.canComposeSms.mockResolvedValue(true);
});

describe("contact invitation selection", () => {
  it("starts unselected, requires a destination, deduplicates, and preserves selection across search/review/back", () => {
    const multi = person("3");
    multi.destinations.push({ kind: "email", value: "person@example.com" });
    render(
      <ContactInvitationSheet
        controller={controller([
          person("1"),
          person("2", person("1").destinations[0]!.value),
          multi,
        ])}
        onFinish={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Select all/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Review 0 invitations" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: "Select Person 3" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Person 1" }));
    expect(
      screen.getByRole("checkbox", { name: "Select Person 2" }),
    ).toBeDisabled();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Destination for Person 3" }),
      { target: { value: "email:person@example.com" } },
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Person 3" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Person 3" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Review 2 invitations" }),
    );
    expect(screen.getByText("Person 1")).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Invitation message for Person 1" }),
    ).toHaveValue(
      "Hi Person 1,\n\nJoin me on One.\nhttps://one.example/r/inviter",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Preview message for Person 3" }),
    );
    expect(
      screen.getByRole("textbox", { name: "Invitation message for Person 3" }),
    ).toHaveValue(
      "Hi Person 3,\n\nJoin me on One.\nhttps://one.example/r/inviter",
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to selection" }));
    expect(
      screen.getByRole("checkbox", { name: "Select Person 3" }),
    ).toBeChecked();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    expect(
      screen.getByRole("checkbox", { name: "Select Person 1" }),
    ).toBeChecked();
  });

  it("keeps selections across pages and labels email-only contacts accurately", () => {
    const rows = Array.from({ length: 51 }, (_, index) =>
      person(String(index + 1)),
    );
    rows[50] = {
      ...rows[50]!,
      classification: "email_only",
      destinations: [{ kind: "email", value: "email@example.com" }],
    };
    render(
      <ContactInvitationSheet
        controller={controller(rows)}
        onFinish={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Person 1" }));
    expect(screen.queryByText("Person 51")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show more contacts" }));
    expect(screen.getByText("Not checked—email only")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Person 51" }));
    expect(
      screen.getByRole("button", { name: "Review 2 invitations" }),
    ).toBeEnabled();
  });

  it("sends only one chosen recipient to the composer, guards double taps, and never advances on cancellation", async () => {
    let complete!: (result: string) => void;
    mocks.compose.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const state = controller([person("1"), person("2")]);
    const finish = vi.fn();
    render(<ContactInvitationSheet controller={state} onFinish={finish} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Person 1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Person 2" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Review 2 invitations" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with 2 invitations" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open Messages" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Messages" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Messages" }));
    expect(mocks.compose).toHaveBeenCalledTimes(1);
    expect(mocks.compose).toHaveBeenCalledWith(person("1").destinations[0], {
      ...state.share,
      text: "Hi Person 1,\n\nJoin me on One.",
    });
    complete("cancelled");
    await screen.findByText(/Cancelled. You can retry/);
    expect(
      screen.queryByRole("button", { name: "Next recipient" }),
    ).not.toBeInTheDocument();
    expect(mocks.compose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.getByText("Person 2")).toBeInTheDocument();
    expect(mocks.compose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(state.clear).toHaveBeenCalled();
    expect(finish).toHaveBeenCalled();
  });

  it("offers preparation retry and preserves selected recipients while it recovers", () => {
    const state = controller([person("1")]);
    state.share = null;
    state.error = "Could not prepare the invitation.";
    const { rerender } = render(
      <ContactInvitationSheet controller={state} onFinish={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Person 1" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Review 1 invitations" }),
    );
    expect(
      screen.getByRole("button", { name: "Continue with 1 invitations" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry invitation link" }),
    );
    expect(state.retryPreparation).toHaveBeenCalledTimes(1);
    rerender(
      <ContactInvitationSheet
        controller={{ ...state, error: null, share: controller([]).share }}
        onFinish={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Continue with 1 invitations" }),
    ).toBeEnabled();
  });

  it("keeps manual recovery available when native compose, copy and share are unavailable", async () => {
    mocks.canComposeSms.mockResolvedValue(false);
    mocks.copy.mockRejectedValue(new Error("clipboard blocked"));
    mocks.share.mockRejectedValue(new Error("no share handler"));
    render(
      <ContactInvitationSheet
        controller={controller([person("1"), person("2")])}
        onFinish={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Person 1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Person 2" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Review 2 invitations" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with 2 invitations" }),
    );
    expect(
      screen.getByRole("button", { name: "Open Messages" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Copy invitation" }));
    await screen.findByRole("alert");
    expect(mocks.copy).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hi Person 1,\n\nJoin me on One." }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Share invitation" }));
    await screen.findByRole("alert");
    expect(
      screen.getByRole("textbox", { name: "Invitation message for Person 1" }),
    ).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.getByText(/1 skipped/)).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Invitation message for Person 2" }),
    ).toHaveValue(
      "Hi Person 2,\n\nJoin me on One.\nhttps://one.example/r/inviter",
    );
    expect(mocks.compose).not.toHaveBeenCalled();
  });

  it("selects and deselects from the contact name and number, with only one toggle per checkbox tap", () => {
    render(
      <ContactInvitationSheet
        controller={controller([person("1")])}
        onFinish={vi.fn()}
      />,
    );
    const checkbox = screen.getByRole("checkbox", { name: "Select Person 1" });
    fireEvent.click(screen.getByText("Person 1"));
    expect(checkbox).toBeChecked();
    fireEvent.click(screen.getByText(person("1").destinations[0]!.value));
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  it("keeps the sheet open when clipboard fallback moves focus outside and confirms successful copy", async () => {
    const state = controller([person("1")]);
    const finish = vi.fn();
    mocks.copy.mockImplementation(async () => {
      const textarea = document.createElement("textarea");
      document.body.append(textarea);
      textarea.focus();
      textarea.remove();
      return "copied";
    });
    render(<ContactInvitationSheet controller={state} onFinish={finish} />);
    fireEvent.click(screen.getByText("Person 1"));
    fireEvent.click(
      screen.getByRole("button", { name: "Review 1 invitations" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with 1 invitations" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy invitation" }));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith("Invitation copied"),
    );
    expect(finish).not.toHaveBeenCalled();
    expect(state.clear).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Invitation message for Person 1" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Done with this contact" }),
    );
    expect(
      screen.getByText("Your invitation queue is complete."),
    ).toBeInTheDocument();
  });

  it.each(["queued_or_sent", "native-share"])(
    "advances after %s without automatically opening another composer",
    async (outcome) => {
      mocks.compose.mockResolvedValue(outcome);
      mocks.share.mockResolvedValue(outcome);
      render(
        <ContactInvitationSheet
          controller={controller([person("1"), person("2")])}
          onFinish={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByText("Person 1"));
      fireEvent.click(screen.getByText("Person 2"));
      fireEvent.click(
        screen.getByRole("button", { name: "Review 2 invitations" }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Continue with 2 invitations" }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Open Messages" }),
        ).toBeEnabled(),
      );
      fireEvent.click(
        screen.getByRole("button", {
          name:
            outcome === "native-share" ? "Share invitation" : "Open Messages",
        }),
      );
      await screen.findByRole("textbox", {
        name: "Invitation message for Person 2",
      });
      expect(
        mocks.compose.mock.calls.length + mocks.share.mock.calls.length,
      ).toBe(1);
      expect(screen.getByText(/1 processed/)).toBeInTheDocument();
    },
  );
});
