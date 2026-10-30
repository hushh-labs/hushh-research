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
    Object.assign(ApiService, { claimAccountPhone: api.ApiService.claimAccountPhone, apiFetch: api.ApiService.apiFetch });
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

  it.each(["recover", "delete", "revoke"] as const)("creates a server-bound %s continuation before leaving the current account", async (action) => {
    const continuationId = "c71a3aab-a901-4f18-8e20-f3fb2fd61a09";
    vi.mocked(fetch).mockImplementation(async (url) => String(url).endsWith("/phone/recovery/continuations")
      ? Response.json({ continuation_id: continuationId, state: "awaiting_previous_sign_in", expires_at: "2099-01-01T00:00:00Z" })
      // While in-place deletion is off (production today), Delete keeps the sign-in handoff.
      : String(url).endsWith("/phone/linked-account/deletions")
        ? Response.json({ detail: { code: "PHONE_LINKED_DELETION_UNAVAILABLE" } }, { status: 503 })
        : Response.json({ detail: { code: "PHONE_TRANSFER_CONFIRMATION_REQUIRED" } }, { status: 409 }));
    render(<AuthProvider><AgentRuntimeStateProvider><PhoneMandatePageContent /></AgentRuntimeStateProvider></AuthProvider>);
    const phone = await screen.findByRole("textbox", { name: "Phone number" });
    fireEvent.change(phone, { target: { value: "6505550101" } });
    fireEvent.submit(phone.closest("form")!);
    const code = await screen.findByRole("textbox", { name: "One-time code" });
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.submit(code.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: action === "delete" ? "Delete my previous account" : action === "revoke" ? "Review previous device access" : "Recover my previous account" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/account/phone/recovery/continuations", expect.objectContaining({
      method: "POST", body: JSON.stringify({ action, phone_number: "+16505550101" }),
    })));
    await waitFor(() => expect(mocks.replaceDocument).toHaveBeenCalled());
    const destination = new URL(mocks.replaceDocument.mock.calls.at(-1)![0], window.location.origin);
    expect(destination.pathname).toBe("/login");
    expect(destination.searchParams.get("redirect")).toBe(`/register-phone?recovery=${continuationId}`);
    expect(destination.href).not.toContain("6505550101");
    expect(destination.href).not.toContain("123456");
  });
  it("deletes the linked account in place with the retained SMS proof, then claims the number", async () => {
    const operation = "d2a5e0f0-8c5e-4f2c-9a51-3f0d6b5f9a11";
    const bodies: Record<string, unknown>[] = [];
    let claims = 0;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const path = String(url);
      if (init?.body) bodies.push({ path, ...JSON.parse(String(init.body)) });
      if (path.endsWith("/phone/linked-account/deletions")) {
        return Response.json({ operation_id: operation, state: "prepared", expires_at: "2099-01-01T00:00:00Z", phone_hint: "••01", transport: "sms" });
      }
      if (path.endsWith("/phone/linked-account/deletions/confirm")) return Response.json({ operation_id: operation, state: "admitted" });
      if (path.endsWith("/phone/claim") && ++claims > 1) {
        return Response.json({ success: true, user_id: "account-owner", phone_verified: true,
          identity: { user_id: "account-owner", phone_number: "+16505550101", phone_verified: true } });
      }
      return Response.json({ detail: { code: "PHONE_TRANSFER_CONFIRMATION_REQUIRED" } }, { status: 409 });
    });
    render(<AuthProvider><AgentRuntimeStateProvider><PhoneMandatePageContent /></AgentRuntimeStateProvider></AuthProvider>);
    const phone = await screen.findByRole("textbox", { name: "Phone number" });
    fireEvent.change(phone, { target: { value: "6505550101" } });
    fireEvent.submit(phone.closest("form")!);
    const code = await screen.findByRole("textbox", { name: "One-time code" });
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.submit(code.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete my previous account" }));
    await screen.findByRole("heading", { name: "Delete the account linked to ••01?" });
    const remove = screen.getByRole("button", { name: "Delete and continue" });
    expect(remove).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "I understand this can’t be undone." }));
    fireEvent.click(remove);
    await waitFor(() => expect(claims).toBe(2));
    expect(bodies.find(body => String(body.path).endsWith("/deletions/confirm"))).toEqual({
      path: "/api/account/phone/linked-account/deletions/confirm", operation_id: operation,
      phone_number: "+16505550101", confirmed: true, phone_id_token: "phone-id-token",
    });
    // One SMS: the retained proof serves the deletion and the follow-up claim.
    expect(mocks.phoneClaimToken).toHaveBeenCalledOnce();
    expect(bodies.some(body => String(body.path).endsWith("/phone/recovery/continuations"))).toBe(false);
    expect(mocks.replaceDocument).not.toHaveBeenCalled();
  });
  it("keeps a wrong-owner continuation generic and never dispatches deletion", async () => {
    const id = "c71a3aab-a901-4f18-8e20-f3fb2fd61a09";
    window.history.replaceState({}, "", `/register-phone?recovery=${id}`);
    vi.mocked(fetch).mockResolvedValue(Response.json({continuation_id: id, state: "awaiting_previous_sign_in"}));
    render(<AuthProvider><AgentRuntimeStateProvider><PhoneMandatePageContent /></AgentRuntimeStateProvider></AuthProvider>);
    await screen.findByRole("heading", { name: "Sign in to your previous account" });
    expect(screen.queryByRole("button", { name: "Review deletion" })).toBeNull();
    expect(screen.queryByText("owner@example.test")).toBeNull();
    expect(fetch).toHaveBeenCalledWith(`/api/account/phone/recovery/continuations/${id}`, expect.objectContaining({method: "GET"}));
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });
  it("@feature_account_deletion @trace_loop leaves the previous-account sign-in loop for the number's in-place choices", async () => {
    const id = "c71a3aab-a901-4f18-8e20-f3fb2fd61a09";
    window.history.replaceState({}, "", `/register-phone?recovery=${id}`);
    vi.mocked(fetch).mockResolvedValue(Response.json({continuation_id: id, state: "awaiting_previous_sign_in"}));
    render(<AuthProvider><AgentRuntimeStateProvider><PhoneMandatePageContent /></AgentRuntimeStateProvider></AuthProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Verify the number here" }));
    // Back to this account's phone form, where Delete my previous account runs in place; no sign-out handoff.
    expect(mocks.routerReplace).toHaveBeenCalledWith("/register-phone");
    expect(mocks.replaceDocument).not.toHaveBeenCalled();
  });
  it("opens the existing deletion review only after server-matched old-owner confirmation", async () => {
    const id = "c71a3aab-a901-4f18-8e20-f3fb2fd61a09";
    window.history.replaceState({}, "", `/register-phone?recovery=${id}`);
    vi.mocked(fetch).mockImplementation(async url => String(url).endsWith(id)
      ? Response.json({continuation_id: id, state: "ready", action: "delete", expires_at: "2099-01-01T00:00:00Z", phone_hint: "••01"})
      : Response.json({providers: ["google.com"], phone_available: true, phone_hint: "••01"}));
    const navigate = vi.fn();
    render(<AuthProvider><AgentRuntimeStateProvider><PhoneMandatePageContent />
      <NativeShellBack label="Recovery shell Back" owner="account-owner" context="register-phone" eligible
        onBack={() => navigateTopShellBack({ pathname: "/register-phone", searchParams: new URLSearchParams(window.location.search), navigate })} />
    </AgentRuntimeStateProvider></AuthProvider>);
    fireEvent.click(await screen.findByRole("button", {name: "Review deletion"}));
    await screen.findByRole("button", { name: "Continue with Google" });
    expect(screen.queryByRole("button", {name: "Permanently delete account"})).toBeNull();
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    fireEvent.click(screen.getByRole("button", {name: "Recovery shell Back"}));
    await screen.findByRole("button", {name: "Review deletion"});
    expect(mocks.routerReplace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name: "Recovery shell Back"}));
    expect(mocks.routerReplace).toHaveBeenCalledWith("/register-phone");
    expect(navigate).not.toHaveBeenCalled();
  });

});
