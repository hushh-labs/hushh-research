import { mocks, resetWebAuthMocks, cleanupWebAuthMocks, makeUser } from "../lib/firebase/fixtures/auth-context-web-harness";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoneMandatePageContent } from "@/app/register-phone/page";
import { AuthProvider } from "@/lib/firebase/auth-context";
import { prepareRecaptchaVerifier } from "@/lib/firebase/config";
import { AgentRuntimeStateProvider, useAgentRuntimeState } from "@/lib/agent/agent-runtime-context";
import { ApiService } from "@/lib/services/api-service";
import { useVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";
import { Navbar } from "@/components/navbar";
import { NativeShellBack } from "@/components/app-ui/native-shell-back";
import { AppEdgeBackGesture } from "@/components/app-ui/app-edge-back-gesture";
import { useBackLayerAvailable } from "@/lib/navigation/back-layers";
import { navigateTopShellBack } from "@/lib/navigation/top-shell-back";

vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: false, vaultOwnerToken: null, tokenExpiresAt: null }) }));
vi.mock("@/lib/persona/persona-context", () => ({ usePersonaState: () => ({ activePersona: "investor", primaryNavPersona: "investor" }) }));
vi.mock("@/components/app-ui/native-route-marker", () => ({ NativeRouteMarker: () => null }));
vi.mock("@/components/vault/vault-lock-guard", () => ({ VaultLockGuard: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/lib/services/post-auth-route-service", () => ({ PostAuthRouteService: { resolveAfterLogin: vi.fn().mockResolvedValue("/register-phone") } }));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({ PreVaultUserStateService: { bootstrapState: vi.fn().mockResolvedValue({ setupCompleted: false }), isSetupResolved: () => false, syncOnboardingJourney: vi.fn() } }));
vi.mock("@/lib/services/phone-mandate-service", () => ({ shouldBypassPhoneMandateForLocalhost: () => false }));

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p>Phone render failed</p> : this.props.children; }
}
function RuntimeProbe() {
  const runtime = useAgentRuntimeState();
  const surface = useVoiceSurfaceMetadata();
  const hasBackLayer = useBackLayerAvailable("/register-phone");
  return <output data-testid="runtime">{runtime.screen}:{surface?.interactionLayer?.id ?? "none"}:{hasBackLayer ? "back" : "no_back"}</output>;
}

describe("register-phone conflict runtime", () => {
  beforeEach(async () => {
    resetWebAuthMocks();
    window.history.replaceState({}, "", "/register-phone?redirect=%2Fone%2Fsetup%2Fcloud");
    mocks.firebaseUser = makeUser("account-owner", "");
    const identity = await vi.importActual<typeof import("@/lib/services/account-identity-service")>("@/lib/services/account-identity-service");
    const api = await vi.importActual<typeof import("@/lib/services/api-service")>("@/lib/services/api-service");
    const firebaseConfig = await vi.importActual<typeof import("@/lib/firebase/config")>("@/lib/firebase/config");
    vi.mocked(prepareRecaptchaVerifier).mockImplementation(firebaseConfig.prepareRecaptchaVerifier);
    Object.assign(ApiService, { claimAccountPhone: api.ApiService.claimAccountPhone });
    mocks.identityClaim.mockImplementation(identity.AccountIdentityService.claimCurrentUserPhone.bind(identity.AccountIdentityService));
    vi.mocked(fetch).mockImplementation(async () => Response.json({ detail: { code: "PHONE_TRANSFER_CONFIRMATION_REQUIRED", message: "Choose how to continue" } }, { status: 409 }));
  });
  afterEach(cleanupWebAuthMocks);

  it("survives real reCAPTCHA setup, phone claim conflict and Back without replacing React-owned DOM", async () => {
    const navigate = vi.fn();
    render(<Boundary><AuthProvider><AgentRuntimeStateProvider>
      <PhoneMandatePageContent /><RuntimeProbe /><Navbar /><AppEdgeBackGesture />
      <NativeShellBack label="Shell Back" onBack={() => navigateTopShellBack({ pathname: "/register-phone", searchParams: new URLSearchParams(window.location.search), navigate })} owner="account-owner" context="register-phone" eligible />
    </AgentRuntimeStateProvider></AuthProvider></Boundary>);
    const phone = await screen.findByRole("textbox", { name: "Phone number" });
    fireEvent.change(phone, { target: { value: "6505550101" } });
    fireEvent.submit(phone.closest("form")!);
    const code = await screen.findByRole("textbox", { name: "One-time code" });
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.submit(code.closest("form")!);
    const review = await screen.findByRole("button", { name: "Use this number on this account" });
    await waitFor(() => expect(screen.getByTestId("runtime")).toHaveTextContent("register_phone:phone_conflict:back"));
    fireEvent.click(review);
    await screen.findByRole("heading", { name: "Use this number on this account?" });
    fireEvent.click(screen.getByRole("button", { name: "Shell Back" }));
    await screen.findByRole("heading", { name: "This number is linked to another account" });
    fireEvent.click(screen.getByRole("button", { name: "Shell Back" }));
    await screen.findByRole("textbox", { name: "Phone number" });
    await waitFor(() => expect(screen.getByTestId("runtime")).toHaveTextContent("register_phone:none:no_back"));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByText("Phone render failed")).toBeNull();
    expect(mocks.phoneClaimToken).toHaveBeenCalledOnce();
    expect(mocks.identityClaim).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/api/account/phone/claim", expect.objectContaining({ method: "POST" }));
    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });
});
