import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  user: null as { uid: string } | null,
  loading: false,
  params: new URLSearchParams(),
  bootstrap: vi.fn(),
  navigate: vi.fn(),
  approve: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => mocks.params }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user, loading: mocks.loading, sessionVerificationRequired: false }) }));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({ PreVaultUserStateService: { bootstrapState: mocks.bootstrap, hasExplicitIncompleteSetup: (s: { setupCompleted: boolean }) => s.setupCompleted === false } }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { authorizeTrustedDevice: mocks.approve } }));
vi.mock("@/lib/utils/browser-navigation", () => ({ assignWindowLocation: mocks.navigate }));
vi.mock("@/lib/auth/use-session-chrome-suppression", () => ({ useSessionChromeSuppression: vi.fn() }));
vi.mock("@/lib/vault/trusted-device-passkey-handoff", () => ({ buildTrustedDevicePasskeyHandoff: vi.fn() }));
vi.mock("@/components/app-ui/native-route-marker", () => ({ NativeRouteMarker: () => null }));
import Page from "@/app/one/profile/security/devices/authorize/page";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = null;
  mocks.loading = false;
  mocks.params = new URLSearchParams({ redirect_uri: "http://127.0.0.1:55573/callback", code_challenge: "synthetic", device_public_key: "synthetic", device_name: "Test device", state: "synthetic_state_123456" });
});
it("ends signed-out enrollment with setup guidance and no authorization request", async () => {
  render(<Page />);
  expect(screen.getByText(/Sign in to One and finish setting up your account/)).toBeTruthy();
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1));
  const callback = new URL(mocks.navigate.mock.calls[0][0]);
  expect(callback.searchParams.get("error")).toBe("login_required");
  expect(callback.searchParams.has("code")).toBe(false);
  expect(mocks.approve).not.toHaveBeenCalled();
});
it("does not end enrollment before auth restoration completes", () => {
  mocks.loading = true;
  render(<Page />);
  expect(screen.getByText("Checking your account…")).toBeTruthy();
  expect(mocks.navigate).not.toHaveBeenCalled();
});
it("does not send a failed enrollment to an external redirect", () => {
  mocks.params.set("redirect_uri", "https://example.com/callback");
  render(<Page />);
  expect(mocks.navigate).not.toHaveBeenCalled();
});
it("ends incomplete setup without approving the device", async () => {
  mocks.user = { uid: "owner" };
  mocks.bootstrap.mockResolvedValue({ userId: "owner", hasVault: true, phoneVerified: true, setupCompleted: false });
  render(<Page />);
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1));
  expect(new URL(mocks.navigate.mock.calls[0][0]).searchParams.get("error")).toBe("account_setup_required");
  expect(mocks.approve).not.toHaveBeenCalled();
});
