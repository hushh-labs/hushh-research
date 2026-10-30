import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContactInvitationSheet as InvitationSheet } from "@/components/connections/contact-invitation-sheet";
import { useInvitationQueue } from "@/lib/contacts/use-invitation-queue";
import type { ContactInvitationController } from "@/lib/contacts/use-contact-invitations";
import type { InviteCandidate } from "@/lib/contacts/invitation-candidates";

const mocks = vi.hoisted(() => ({
  composeBatch: vi.fn(),
  native: true,
  share: vi.fn(),
  copy: vi.fn(),
  canComposeBatchSms: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/services/contact-invitations-service", () => ({
  invitationBody: (share: { text: string; url: string }) =>
    `${share.text}\n${share.url}`,
  ContactInvitationsService: {
    ...mocks,
    isNative: () => mocks.native,
    canComposeBatchSms: mocks.canComposeBatchSms,
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
  mocks.native = true;
  mocks.composeBatch.mockResolvedValue("cancelled");
  mocks.copy.mockResolvedValue("copied");
  mocks.share.mockResolvedValue("native-share");
  mocks.canComposeBatchSms.mockResolvedValue(true);
});

describe("contact invitation batches", () => {
  it("manually selects at most 15, deduplicates, preserves selection through search and production Back", async () => {
    const { dismissTopmostOverlay } = await import(
      "@/lib/navigation/back-layers"
    );
    render(
      <ContactInvitationSheet
        controller={controller(
          Array.from({ length: 16 }, (_, i) => person(String(i + 1))).concat(
            person("duplicate", person("1").destinations[0]!.value),
          ),
        )}
        onFinish={vi.fn()}
      />,
    );
    expect(
      screen
        .getAllByRole("checkbox")
        .every((box) => box.getAttribute("aria-checked") === "false"),
    ).toBe(true);
    for (let i = 1; i <= 15; i++)
      fireEvent.click(
        screen.getByRole("checkbox", { name: `Select Person ${i}` }),
      );
    expect(
      screen.getByRole("checkbox", { name: "Select Person 16" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: "Select Person duplicate" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByText("Person 15"));
    expect(
      screen.getByRole("checkbox", { name: "Select Person 16" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByText("Person 16"));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Person 2" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Review 15 invitations" }),
    );
    expect(
      screen.getByRole("textbox", { name: "Invitation message" }),
    ).toHaveValue("Join me on One.\nhttps://one.example/r/inviter");
    expect(screen.getByText(/recipients can see each other/)).toBeVisible();
    dismissTopmostOverlay();
    await screen.findByRole("textbox", { name: "Search contacts to invite" });
    expect(
      screen.getByRole("checkbox", { name: "Select Person 2" }),
    ).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Review 15 invitations" }),
    ).toBeEnabled();
  });

  it("hands the entire common-message batch off once, blocks duplicate taps and busy Back, retains cancellation", async () => {
    const { dismissTopmostOverlay } = await import(
      "@/lib/navigation/back-layers"
    );
    let complete!: (result: string) => void;
    mocks.composeBatch.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const rows = Array.from({ length: 15 }, (_, i) => person(String(i + 1)));
    const state = controller(rows);
    render(<ContactInvitationSheet controller={state} onFinish={vi.fn()} />);
    for (let i = 1; i <= 15; i++)
      fireEvent.click(screen.getByText(`Person ${i}`));
    fireEvent.click(
      screen.getByRole("button", { name: "Review 15 invitations" }),
    );
    const open = await screen.findByRole("button", {
      name: "Open Messages · 15 contacts",
    });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    fireEvent.click(open);
    dismissTopmostOverlay();
    expect(screen.getByText("Your invitation")).toBeVisible();
    expect(mocks.composeBatch).toHaveBeenCalledTimes(1);
    expect(mocks.composeBatch).toHaveBeenCalledWith(
      rows.map((row) => row.destinations[0]),
      state.share,
      expect.any(Function),
    );
    await act(async () => complete("cancelled"));
    expect(
      screen.getByText(/Cancelled. Your selection is saved/),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back to review" }));
    expect(screen.getByText("15 selected contacts")).toBeVisible();
    expect(mocks.composeBatch).toHaveBeenCalledTimes(1);
  });

  it("requires an explicit destination, preserves recovery when an older binary cannot batch", async () => {
    mocks.canComposeBatchSms.mockResolvedValue(false);
    mocks.copy.mockRejectedValue(new Error("clipboard blocked"));
    const multi = person("1");
    multi.destinations.push({ kind: "phone", value: "+14155550999" });
    render(
      <ContactInvitationSheet
        controller={controller([multi])}
        onFinish={vi.fn()}
      />,
    );
    expect(screen.getByRole("checkbox")).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "phone:+14155550999" },
    });
    fireEvent.click(screen.getByText("Person 1"));
    fireEvent.click(
      screen.getByRole("button", { name: "Review 1 invitation" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Open Messages/ }),
      ).toBeDisabled(),
    );
    expect(
      await screen.findByText(/Batch Messages is unavailable/),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Copy invitation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Could not open or copy/,
    );
    expect(
      screen.getByRole("textbox", { name: "Invitation message" }),
    ).toHaveAttribute("readonly");
    expect(mocks.composeBatch).not.toHaveBeenCalled();
  });

  it("uses email destinations on web, keeps paging selections and handles phone-only empty results", async () => {
    mocks.native = false;
    mocks.composeBatch.mockResolvedValue("launch_requested");
    const rows: InviteCandidate[] = Array.from({ length: 51 }, (_, i) => ({
      ...person(String(i + 1)),
      destinations: [
        { kind: "email" as const, value: `person${i + 1}@example.com` },
      ],
      classification: "email_only" as const,
    }));
    rows[0]!.destinations.push({ kind: "phone", value: "+14155550101" });
    const { unmount } = render(
      <ContactInvitationSheet
        controller={controller(rows.concat(person("phone")))}
        onFinish={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Person 1"));
    expect(screen.queryByText("Person 51")).not.toBeInTheDocument();
    expect(screen.queryByText("Person phone")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show more contacts" }));
    fireEvent.click(screen.getByText("Person 51"));
    fireEvent.click(
      screen.getByRole("button", { name: "Review 2 invitations" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open email · 2 contacts" }),
    );
    await screen.findByText(/Email draft requested/);
    expect(mocks.composeBatch).toHaveBeenCalledWith(
      [rows[0]!.destinations[0], rows[50]!.destinations[0]],
      expect.objectContaining({ text: "Join me on One." }),
      expect.any(Function),
    );
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
    unmount();
    render(
      <ContactInvitationSheet
        controller={controller([person("1")])}
        onFinish={vi.fn()}
      />,
    );
    expect(screen.getByText(/No contacts with an email address/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Review 0 invitations" }),
    ).toBeDisabled();
  });

  it("recovers invitation preparation with no web email candidates without resync", async () => {
    mocks.native = false;
    const state = controller([person("1")]);
    state.share = null;
    state.error = "Could not prepare the invitation.";
    const { rerender } = render(
      <ContactInvitationSheet controller={state} onFinish={vi.fn()} />,
    );
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
    fireEvent.click(screen.getByRole("button", { name: "Copy invitation" }));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith("Invitation copied"),
    );
    expect(mocks.copy).toHaveBeenCalledWith(
      controller([]).share,
      expect.any(Function),
    );
  });

  it("keeps copy feedback and selection when clipboard fallback moves focus outside", async () => {
    mocks.copy.mockImplementation(async () => {
      const textarea = document.createElement("textarea");
      document.body.append(textarea);
      textarea.focus();
      textarea.remove();
      return "copied";
    });
    const state = controller([person("1")]);
    const finish = vi.fn();
    render(<ContactInvitationSheet controller={state} onFinish={finish} />);
    fireEvent.click(screen.getByText("Person 1"));
    fireEvent.click(
      screen.getByRole("button", { name: "Review 1 invitation" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy invitation" }));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith("Invitation copied"),
    );
    expect(finish).not.toHaveBeenCalled();
    expect(state.clear).not.toHaveBeenCalled();
    expect(screen.getByText("1 selected contact")).toBeVisible();
  });
});
