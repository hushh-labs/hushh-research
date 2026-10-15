import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  reloadResearch: vi.fn(),
  preferences: null as null | {
    enabled: boolean;
    email_enabled: boolean;
    consent_version: "pwm-native-v1";
  },
  preview: vi.fn(),
  list: vi.fn(),
  claim: vi.fn(),
  reject: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mock.push,
    replace: mock.replace,
    refresh: mock.refresh,
  }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/components/profile/world-model-provider", () => ({
  useWorldModelResearch: () => ({
    reload: mock.reloadResearch,
    preferences: mock.preferences,
  }),
}));
vi.mock("@/lib/agent/agent-pkm-capture-runtime", () => ({
  createAgentPkmCaptureGuard: ({
    signal,
    isEnabled,
  }: {
    signal: AbortSignal;
    isEnabled: () => boolean;
  }) => ({
    isCurrent: () => !signal.aborted && isEnabled(),
    assertCurrent: async () => {
      if (signal.aborted || !isEnabled()) throw new Error("stale");
    },
  }),
}));
vi.mock("@/lib/services/world-model-invitations-service", () => ({
  WorldModelInvitationsService: {
    preview: mock.preview,
    list: mock.list,
    claim: mock.claim,
    reject: mock.reject,
  },
}));

import { WorldModelClaimInvitation } from "@/components/profile/world-model-claim-invitation";
import {
  createWorldModelInvitationHandoff,
  readWorldModelInvitationHandoff,
  worldModelInvitationClaimRoute,
} from "@/lib/world-model/invitation-handoff";

const token = "a".repeat(43);

beforeEach(() => {
  vi.clearAllMocks();
  mock.preferences = null;
  window.sessionStorage.clear();
  const handoff = createWorldModelInvitationHandoff(token, "recipient")!;
  window.history.replaceState(
    {},
    "",
    worldModelInvitationClaimRoute(handoff),
  );
  mock.preview.mockResolvedValue({ has_preview: false });
  mock.list.mockResolvedValue([]);
  mock.claim.mockResolvedValue({
    claimed: true,
    sharing_granted: false,
    research_started: false,
    draft_id: null,
  });
});

it("lets a verified recipient claim a previewless invitation without promising source details", async () => {
  render(
    <WorldModelClaimInvitation
      ownerId="recipient"
      vaultKey="vault-key"
      vaultOwnerToken="owner-token"
    />,
  );
  await waitFor(() => expect(mock.preview).toHaveBeenCalledWith(token));
  expect(screen.getByText(/choose whether to claim or reject/)).toBeInTheDocument();
  expect(screen.queryByText(/starting profile|source details above/i)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Claim my model" }));
  await waitFor(() =>
    expect(mock.claim).toHaveBeenCalledWith(
      { vaultKey: "vault-key", vaultOwnerToken: "owner-token" },
      token,
      false,
    ),
  );
  expect(
    await screen.findByText(/you can now review your model here/i),
  ).toBeInTheDocument();
  expect(mock.replace).toHaveBeenCalledWith("/one/profile/world-model");
  expect(mock.reloadResearch).toHaveBeenCalled();
  expect(
    readWorldModelInvitationHandoff(
      new URL(window.location.href).searchParams.get("handoff")!,
      "recipient",
    ),
  ).toBeNull();
});

it.each([
  ["on by default", true, false],
  ["turned off and left off", false, false],
  ["turned off and turned back on", false, true],
])(
  "asks about research only when the recipient turned it off (%s)",
  async (_case, enabled, check) => {
    mock.preferences = {
      enabled,
      email_enabled: true,
      consent_version: "pwm-native-v1",
    };
    render(
      <WorldModelClaimInvitation
        ownerId="recipient"
        vaultKey="vault-key"
        vaultOwnerToken="owner-token"
      />,
    );
    await screen.findByRole("button", { name: "Claim my model" });
    const box = screen.queryByRole("checkbox", {
      name: "Turn public research back on after claiming",
    });
    // Negative control: default-on research shows no box and requests nothing.
    if (enabled) expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    else expect(box).toBeInTheDocument();
    if (check) fireEvent.click(box!);
    fireEvent.click(screen.getByRole("button", { name: "Claim my model" }));
    await waitFor(() =>
      expect(mock.claim).toHaveBeenCalledWith(
        { vaultKey: "vault-key", vaultOwnerToken: "owner-token" },
        token,
        check,
      ),
    );
  },
);

it("clears the handoff after the recipient rejects the invitation", async () => {
  mock.reject.mockResolvedValue({ rejected: true });
  render(
    <WorldModelClaimInvitation
      ownerId="recipient"
      vaultKey="vault-key"
      vaultOwnerToken="owner-token"
    />,
  );
  await screen.findByRole("button", { name: "Reject invitation" });
  fireEvent.click(screen.getByRole("button", { name: "Reject invitation" }));
  await waitFor(() => expect(mock.reject).toHaveBeenCalledWith(
    { vaultKey: "vault-key", vaultOwnerToken: "owner-token" },
    token,
  ));
  expect(await screen.findByText("Invitation rejected.")).toBeInTheDocument();
  expect(
    readWorldModelInvitationHandoff(
      new URL(window.location.href).searchParams.get("handoff")!,
      "recipient",
    ),
  ).toBeNull();
});

it("routes a different signed-in account back to explicit invitation recovery", async () => {
  render(
    <WorldModelClaimInvitation
      ownerId="different-account"
      vaultKey="vault-key"
      vaultOwnerToken="owner-token"
    />,
  );
  expect(await screen.findByText(/opened with another account/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Claim my model" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review invitation with this account" }));
  const destination = mock.replace.mock.lastCall![0] as string;
  expect(destination).toMatch(/^\/world-model\/invite\?handoff=/);
  expect(destination).not.toContain(token);
  expect(mock.claim).not.toHaveBeenCalled();
});
