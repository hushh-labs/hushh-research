import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({ options: vi.fn(), reauthenticate: vi.fn(), deleteAccount: vi.fn(), startPhone: vi.fn() }));
vi.mock("@capacitor/core", async (original) => ({
  ...await original<typeof import("@capacitor/core")>(),
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web", isPluginAvailable: () => false },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ resolveVerifiedPhoneNumber: async () => null }) }));
vi.mock("@/lib/services/account-service", () => ({ AccountService: { getLostVaultDeleteOptions: ports.options } }));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { reauthenticateAccountDeletionIdentity: ports.reauthenticate, startPhoneDeletionVerification: ports.startPhone, cancelPhoneDeletionVerification: async () => {} },
}));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {} }));
vi.mock("@/lib/auth/google-signup-token", () => ({ preloadGoogleSignupAuth: async () => {} }));
vi.mock("@/lib/firebase/config", () => ({ resetRecaptcha: () => {}, prepareRecaptchaVerifier: vi.fn() }));
vi.mock("@/lib/flows/delete-account", () => ({
  executeLostVaultAccountDeletion: ports.deleteAccount, lostVaultDeletionErrorMessage: () => "Verify again.",
}));

import { LostVaultDeletePanel } from "@/components/vault/lost-vault-delete-panel";
import { publishValidatedAuthSessionOwner, publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";

describe("lost-vault Google verification recovery", () => {
  const user = { uid: "owner-1", getIdToken: async () => "current-session-token" } as unknown as Parameters<typeof LostVaultDeletePanel>[0]["user"];
  beforeEach(() => {
    vi.clearAllMocks();
    ports.options.mockResolvedValue({ phone_available: true, phone_hint: null, providers: ["google.com"] });
    ports.reauthenticate.mockResolvedValue("fresh-provider-token");
    publishValidatedAuthSessionPrincipal({ firebaseUid: user.uid, ownerId: user.uid, accountGeneration: 0 });
  });
  afterEach(() => { cleanup(); publishValidatedAuthSessionOwner(null); });

  it.each([
    ["identity_initialization_not_ready", "Google sign-in is getting ready"],
    ["identity_timeout", "Your sign-in check timed out"],
  ])("keeps %s retryable without submitting deletion", async (code, message) => {
    ports.reauthenticate.mockRejectedValueOnce(new Error(code));
    render(<LostVaultDeletePanel user={user} onBack={vi.fn()} />);
    const google = await screen.findByRole("button", { name: "Continue with Google" });
    fireEvent.click(google);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(google).toBeEnabled();
    expect(ports.startPhone).not.toHaveBeenCalled();
    expect(ports.deleteAccount).not.toHaveBeenCalled();
    fireEvent.click(google);
    await screen.findByLabelText("Mobile number");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(ports.deleteAccount).not.toHaveBeenCalled();
  });
});
