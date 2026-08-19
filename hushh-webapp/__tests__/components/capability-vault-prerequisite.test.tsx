import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CapabilityVaultPrerequisite } from "@/components/vault/capability-vault-prerequisite";
import { getVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

const vaultMocks = vi.hoisted(() => ({
  checkVault: vi.fn(),
  vaultOwnerToken: null as string | null,
  user: { uid: "user_1" } as { uid: string } | null,
  routerReplace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/one/setup/location",
  useRouter: () => ({ replace: vaultMocks.routerReplace }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: vaultMocks.user, loading: false }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: vaultMocks.vaultOwnerToken }),
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: { checkVault: vaultMocks.checkVault },
}));

vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: ({
    open,
    title,
    enableGeneratedDefault,
    onSuccess,
  }: {
    open: boolean;
    title: string;
    enableGeneratedDefault?: boolean;
    onSuccess: () => void;
  }) =>
    open ? (
      <div
        role="dialog"
        aria-label={title}
        data-generated-default={String(enableGeneratedDefault)}
      >
        <button type="button" onClick={onSuccess}>
          Complete vault setup
        </button>
      </div>
    ) : null,
}));

describe("CapabilityVaultPrerequisite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vaultMocks.vaultOwnerToken = null;
    vaultMocks.user = { uid: "user_1" };
    vaultMocks.checkVault.mockResolvedValue(false);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a capability immediately when its in-memory owner token exists", () => {
    vaultMocks.vaultOwnerToken = "owner-token";

    render(
      <CapabilityVaultPrerequisite capabilityLabel="Location" routeKey="/one/setup/location">
        <div>Location workspace</div>
      </CapabilityVaultPrerequisite>,
    );

    expect(screen.getByText("Location workspace")).toBeTruthy();
    expect(vaultMocks.checkVault).not.toHaveBeenCalled();
  });

  it("retains the Login boundary for unauthenticated direct entry", async () => {
    vaultMocks.user = null;

    render(
      <CapabilityVaultPrerequisite capabilityLabel="Location" routeKey="/one/location">
        <div>Location workspace</div>
      </CapabilityVaultPrerequisite>,
    );

    await waitFor(() => {
      expect(vaultMocks.routerReplace).toHaveBeenCalledWith(
        "/login?redirect=%2Fone%2Flocation",
      );
    });
    expect(screen.queryByText("Location workspace")).toBeNull();
    expect(vaultMocks.checkVault).not.toHaveBeenCalled();
  });

  it("opens the shared vault flow before mounting a no-vault capability and suppresses route actions", async () => {
    render(
      <CapabilityVaultPrerequisite capabilityLabel="Location" routeKey="/one/setup/location">
        <div>Location workspace</div>
      </CapabilityVaultPrerequisite>,
    );

    await waitFor(() => expect(vaultMocks.checkVault).toHaveBeenCalledWith("user_1"));
    expect(await screen.findByRole("dialog", { name: /^set up your private vault$/i })).toBeTruthy();
    expect(
      screen.getByRole("dialog", {
        name: /^set up your private vault$/i,
      }).getAttribute("data-generated-default"),
    ).toBe("true");
    expect(screen.queryByText("Location workspace")).toBeNull();
    expect(getVoiceSurfaceMetadata()?.interactionLayer).toMatchObject({
      kind: "vault_setup",
      modality: "blocking",
      agentContinuity: "suppressed",
    });
  });

  it("waits for the in-memory vault authority after creation instead of rechecking a new vault", async () => {
    const { rerender } = render(
      <CapabilityVaultPrerequisite capabilityLabel="Location" routeKey="/one/setup/location">
        <div>Location workspace</div>
      </CapabilityVaultPrerequisite>,
    );

    await screen.findByRole("dialog", {
      name: /^set up your private vault$/i,
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete vault setup" }));

    expect(await screen.findByText("Opening Location…")).toBeTruthy();
    expect(vaultMocks.checkVault).toHaveBeenCalledTimes(1);

    vaultMocks.vaultOwnerToken = "owner-token";
    rerender(
      <CapabilityVaultPrerequisite capabilityLabel="Location" routeKey="/one/setup/location">
        <div>Location workspace</div>
      </CapabilityVaultPrerequisite>,
    );

    expect(await screen.findByText("Location workspace")).toBeTruthy();
    expect(vaultMocks.checkVault).toHaveBeenCalledTimes(1);
  });

  it("uses opening language when an existing vault needs to be unlocked", async () => {
    vaultMocks.checkVault.mockResolvedValue(true);

    render(
      <CapabilityVaultPrerequisite capabilityLabel="Location" routeKey="/one/location">
        <div>Location workspace</div>
      </CapabilityVaultPrerequisite>,
    );

    await screen.findByRole("dialog", { name: /^open your private vault$/i });
    expect(screen.queryByRole("heading", { name: /open your private vault first/i })).toBeNull();
  });

  it("retains the capability boundary when the presence check fails and supports retry", async () => {
    vaultMocks.checkVault.mockRejectedValueOnce(new Error("temporary failure"));
    vaultMocks.checkVault.mockResolvedValueOnce(false);

    render(
      <CapabilityVaultPrerequisite capabilityLabel="Location" routeKey="/one/location">
        <div>Location workspace</div>
      </CapabilityVaultPrerequisite>,
    );

    expect(await screen.findByText(/could not confirm your vault/i)).toBeTruthy();
    await act(async () => {
      screen.getByRole("button", { name: "Try again" }).click();
    });
    await waitFor(() => expect(vaultMocks.checkVault).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("dialog", { name: /^set up your private vault$/i })).toBeTruthy();
    expect(screen.queryByText("Location workspace")).toBeNull();
  });
});
