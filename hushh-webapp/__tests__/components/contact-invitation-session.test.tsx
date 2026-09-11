import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useContext, useLayoutEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContactInvitationSessionProvider } from "@/components/connections/contact-invitation-session-provider";
import { ContactSyncResultsSheet } from "@/components/one-location/contact-sync-results-sheet";
import {
  ContactInvitationSessionContext,
  useContactInvitations,
  type ContactInvitationController,
} from "@/lib/contacts/use-contact-invitations";

const mocks = vi.hoisted(() => ({
  owner: "owner-a" as string | null,
  pathname: "/connect",
  compose: vi.fn(),
  share: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.owner ? { uid: mocks.owner } : null }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("sonner", () => ({ toast: { success: mocks.toast, error: vi.fn() } }));
vi.mock(
  "@/lib/services/contact-invitations-service",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/lib/services/contact-invitations-service")
      >();
    return {
      ...original,
      ContactInvitationsService: {
        isNative: () => true,
        canComposeSms: async () => true,
        completesRecipient: (result: string) =>
          ["queued_or_sent", "native-share"].includes(result),
        compose: mocks.compose,
        share: mocks.share,
        copy: async () => "copied",
      },
    };
  },
);

let session: ContactInvitationController;
function Observe() {
  const controller = useContext(ContactInvitationSessionContext)!.controller;
  useLayoutEffect(() => {
    session = controller;
  }, [controller]);
  return null;
}
function Route() {
  const invitations = useContactInvitations(mocks.owner);
  // These are the empty route-local values after an admission gate remount.
  return (
    <ContactSyncResultsSheet
      open={false}
      result={null}
      invitations={invitations}
      syncing={false}
      onOpenChange={(open) => {
        if (!open) invitations.clear();
      }}
      onSyncAgain={vi.fn()}
      onInvite={vi.fn()}
      onRequestConnection={vi.fn()}
    />
  );
}
function App({ blocked = false }: { blocked?: boolean }) {
  return (
    <ContactInvitationSessionProvider>
      <Observe />
      {blocked ? <div>Checking session</div> : <Route />}
    </ContactInvitationSessionProvider>
  );
}
async function start() {
  act(() =>
    session.beginSync()?.([
      {
        id: "one",
        displayName: "Person One",
        classification: "no_match",
        destinations: [{ kind: "phone", value: "+14155550101" }],
      },
      {
        id: "two",
        displayName: "Person Two",
        classification: "no_match",
        destinations: [{ kind: "phone", value: "+14155550102" }],
      },
    ]),
  );
  await act(async () => {
    await session.open(async () => ({
      title: "Invite",
      text: "Join me on One.",
      url: "https://one.example/r/test",
      dialogTitle: "Invite",
    }));
  });
  fireEvent.click(screen.getByText("Person One"));
  fireEvent.click(screen.getByText("Person Two"));
  fireEvent.click(screen.getByRole("button", { name: "Review 2 invitations" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Continue with 2 invitations" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Open Messages" })).toBeEnabled(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_CONTACT_INVITATIONS_ENABLED", "true");
  mocks.owner = "owner-a";
  mocks.pathname = "/connect";
});

describe("invitation session across native and browser return", () => {
  it.each([
    ["compose", "queued_or_sent", "Person Two"],
    ["compose", "cancelled", "Person One"],
    ["compose", "failed", "Person One"],
    ["compose", "opened", "Person One"],
    ["share", "native-share", "Person Two"],
    ["share", "cancelled", "Person One"],
  ])(
    "restores %s / %s after the auth gate removes the entire route",
    async (kind, outcome, recipient) => {
      let resolve!: (result: string) => void;
      let reject!: (error: unknown) => void;
      const handoff = new Promise<string>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      mocks[kind as "compose" | "share"].mockReturnValue(handoff);
      const { rerender } = render(<App />);
      await start();
      fireEvent.click(
        screen.getByRole("button", {
          name: kind === "compose" ? "Open Messages" : "Share invitation",
        }),
      );
      rerender(<App blocked />);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.queryByText("Person One")).not.toBeInTheDocument();
      await act(async () => {
        if (kind === "share" && outcome === "cancelled")
          reject(new DOMException("Cancelled", "AbortError"));
        else resolve(outcome);
      });
      rerender(<App />);
      await screen.findByRole("textbox", {
        name: `Invitation message for ${recipient}`,
      });
      expect(session.candidates).toHaveLength(2);
      expect(
        mocks.compose.mock.calls.length + mocks.share.mock.calls.length,
      ).toBe(1);
      expect(
        screen.queryByRole("button", { name: "Next recipient" }),
      ).not.toBeInTheDocument();
    },
  );

  it.each(["navigation", "account", "logout", "finish", "resync", "disabled"])(
    "clears state and ignores a late composer result after %s",
    async (change) => {
      let resolve!: (result: string) => void;
      mocks.compose.mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const { rerender } = render(<App />);
      await start();
      fireEvent.click(screen.getByRole("button", { name: "Open Messages" }));
      if (change === "navigation") mocks.pathname = "/one/location";
      if (change === "account") mocks.owner = "owner-b";
      if (change === "logout") mocks.owner = null;
      if (change === "disabled")
        vi.stubEnv("NEXT_PUBLIC_CONTACT_INVITATIONS_ENABLED", "false");
      if (change === "finish")
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
      if (change === "resync")
        act(() => {
          session.beginSync();
        });
      rerender(<App />);
      await act(async () => {
        resolve("queued_or_sent");
      });
      expect(session.active).toBe(false);
      expect(session.candidates).toEqual([]);
      expect(session.draft.selected).toEqual({});
      expect(session.draft.processed.size).toBe(0);
      expect(session.draft.busy).toBe(false);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it("keeps selection/review state through repeated remounts without persistent storage", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const { rerender, unmount } = render(<App />);
    await start();
    for (let count = 0; count < 3; count++) {
      rerender(<App blocked />);
      rerender(<App />);
      expect(
        screen.getByRole("textbox", {
          name: "Invitation message for Person One",
        }),
      ).toBeInTheDocument();
    }
    expect(storage).not.toHaveBeenCalled();
    const isCurrent = session.captureSession();
    unmount();
    expect(isCurrent()).toBe(false);
    storage.mockRestore();
  });
});
