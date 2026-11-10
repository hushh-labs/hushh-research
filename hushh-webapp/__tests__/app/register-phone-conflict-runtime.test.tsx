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
    Object.assign(ApiService, { refreshAccountIdentityShadow: api.ApiService.refreshAccountIdentityShadow, apiFetch: api.ApiService.apiFetch });
    mocks.phoneFinalize.mockImplementation(identity.AccountIdentityService.finalizeNativePhoneVerification.bind(identity.AccountIdentityService));
    mocks.phoneLinkConfirm.mockImplementation(async ({ phoneNumber }) => {
      const user = mocks.firebaseUser as import("firebase/auth").User;
      Object.assign(user, { phoneNumber });
      return user;
    });
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
    await screen.findByRole("button", { name: "Delete my previous account" });
    await waitFor(() => expect(screen.getByTestId("runtime")).toHaveTextContent("register_phone:phone_conflict:back"));
    fireEvent.click(screen.getByRole("button", { name: "Shell Back" }));
    await screen.findByRole("textbox", { name: "Phone number" });
    await waitFor(() => expect(screen.getByTestId("runtime")).toHaveTextContent("register_phone:none:no_back"));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByText("Phone render failed")).toBeNull();
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
    expect(mocks.identityClaim).not.toHaveBeenCalled();
    expect(mocks.phoneFinalize).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/api/account/identity/refresh?require_success=true", expect.objectContaining({ method: "POST", body: JSON.stringify({ verified_phone_number: "+16505550101" }) }));
    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });

  it.each(["delete"] as const)("creates a server-bound %s review continuation before leaving the current account", async (action) => {
    const continuationId = "c71a3aab-a901-4f18-8e20-f3fb2fd61a09";
    vi.mocked(fetch).mockImplementation(async (url) => String(url).endsWith("/phone/recovery/continuations")
      ? Response.json({ continuation_id: continuationId, state: "awaiting_previous_sign_in", expires_at: "2099-01-01T00:00:00Z" })
      : String(url).endsWith("/linked-account/deletions")
        ? Response.json({ detail: { code: "PHONE_LINKED_DELETION_UNAVAILABLE" } }, { status: 503 })
        : Response.json({ detail: { code: "PHONE_TRANSFER_CONFIRMATION_REQUIRED" } }, { status: 409 }));
    render(<AuthProvider><AgentRuntimeStateProvider><PhoneMandatePageContent /></AgentRuntimeStateProvider></AuthProvider>);
    const phone = await screen.findByRole("textbox", { name: "Phone number" });
    fireEvent.change(phone, { target: { value: "6505550101" } });
    fireEvent.submit(phone.closest("form")!);
    const code = await screen.findByRole("textbox", { name: "One-time code" });
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.submit(code.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete my previous account" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/account/phone/recovery/continuations", expect.objectContaining({
      method: "POST", body: JSON.stringify({ action, phone_number: "+16505550101" }),
    })));
    await waitFor(() => expect(mocks.replaceDocument).toHaveBeenCalled());
    const destination = new URL(mocks.replaceDocument.mock.calls.at(-1)![0], window.location.origin);
    expect(destination.pathname).toBe("/login");
    expect(destination.searchParams.get("redirect")).toBe(`/register-phone?recovery=${continuationId}`);
    expect(destination.href).not.toContain("6505550101");
    expect(destination.href).not.toContain("123456");
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/linked-account/deletions/confirm") || String(url).includes("/delete-lost-vault"))).toBe(false);
  });
  it("@feature_account_deletion requests in-place deletion with the retained SMS proof and never claims the number with it", async () => {
    mocks.phoneLinkConfirm.mockImplementationOnce(async ({ onConflictProof }) => {
      onConflictProof("phone-id-token");
      throw Object.assign(new Error("Phone held"), { code: "credential-already-in-use" });
    });
    const operation = "5f0c2a64-3c1e-4f5a-9f43-2a8f0c8e7b11";
    vi.mocked(fetch).mockImplementation(async (url) => String(url).endsWith("/linked-account/deletions")
      ? Response.json({ operation_id: operation, state: "prepared", expires_at: "2099-01-01T00:00:00Z", phone_hint: "••01", transport: "sms" })
      : String(url).endsWith("/linked-account/deletions/confirm")
        ? Response.json({ operation_id: operation, state: "admitted" })
        : Response.json({ detail: { code: "PHONE_TRANSFER_CONFIRMATION_REQUIRED" } }, { status: 409 }));
    render(<AuthProvider><AgentRuntimeStateProvider><PhoneMandatePageContent /></AgentRuntimeStateProvider></AuthProvider>);
    const phone = await screen.findByRole("textbox", { name: "Phone number" });
    fireEvent.change(phone, { target: { value: "6505550101" } });
    fireEvent.submit(phone.closest("form")!);
    const code = await screen.findByRole("textbox", { name: "One-time code" });
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.submit(code.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete my previous account" }));
    const remove = await screen.findByRole("button", { name: "Delete that account" });
    expect(remove).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "I understand this can’t be undone." }));
    fireEvent.click(remove); fireEvent.click(remove);
    await screen.findByRole("heading", { name: "Deletion requested" });
    const calls = vi.mocked(fetch).mock.calls.map(([url, init]) => ({ url: String(url), body: String(init?.body ?? "") }));
    const confirms = calls.filter(call => call.url.endsWith("/linked-account/deletions/confirm"));
    expect(confirms).toHaveLength(1);
    expect(JSON.parse(confirms[0]!.body)).toEqual({ operation_id: operation, phone_number: "+16505550101", confirmed: true, phone_id_token: "phone-id-token" });
    // Negative control: the spent proof belongs to the previous holder and never claims the number here.
    expect(calls.filter(call => call.url.endsWith("/api/account/phone/claim"))).toHaveLength(0);
    expect(calls.some(call => call.url.includes("/recovery/continuations"))).toBe(false);
    expect(mocks.replaceDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Verify this number again" }));
    await screen.findByRole("textbox", { name: "Phone number" });
    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });
  it("@feature_account_deletion reads a lost confirmation back with Check again and never sends it twice", async () => {
    mocks.phoneLinkConfirm.mockImplementationOnce(async ({ onConflictProof }) => {
      onConflictProof("phone-id-token");
      throw Object.assign(new Error("Phone held"), { code: "credential-already-in-use" });
    });
    const operation = "5f0c2a64-3c1e-4f5a-9f43-2a8f0c8e7b12";
    let admitted = false;
    vi.mocked(fetch).mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith("/linked-account/deletions")) {
        return Response.json({ operation_id: operation, state: "prepared", expires_at: "2099-01-01T00:00:00Z", phone_hint: "••01", transport: "sms" });
      }
      // The confirmation's response is lost; the server may still be running it.
      if (path.endsWith("/linked-account/deletions/confirm")) throw new TypeError("Failed to fetch");
      if (path.endsWith(`/linked-account/deletions/${operation}`)) return Response.json({ operation_id: operation, state: admitted ? "admitted" : "prepared" });
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
    fireEvent.click(await screen.findByRole("checkbox", { name: "I understand this can’t be undone." }));
    fireEvent.click(screen.getByRole("button", { name: "Delete that account" }));
    // "prepared" after a lost response can still be admitted: unconfirmed, with no Cancel and no second confirmation.
    const check = await screen.findByRole("button", { name: "Check again" }, { timeout: 4_000 });
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete that account" })).toBeNull();
    admitted = true;
    fireEvent.click(check);
    await screen.findByRole("heading", { name: "Deletion requested" });
    const calls = vi.mocked(fetch).mock.calls.map(([url, init]) => ({ url: String(url), method: init?.method ?? "GET", body: String(init?.body ?? "") }));
    // Negative control: the old Check again sent the proof in a second confirmation.
    expect(calls.filter(call => call.url.endsWith("/linked-account/deletions/confirm"))).toHaveLength(1);
    const reads = calls.filter(call => call.url.endsWith(`/linked-account/deletions/${operation}`));
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads.every(call => call.method === "GET" && !call.body.includes("phone-id-token"))).toBe(true);
    expect(calls.filter(call => call.url.endsWith("/api/account/phone/claim"))).toHaveLength(0);
  }, 10_000);
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
  it("@feature_account_deletion @trace_loop returns to phone entry without permitting another email to delete the existing account", async () => {
    const id = "c71a3aab-a901-4f18-8e20-f3fb2fd61a09";
    window.history.replaceState({}, "", `/register-phone?recovery=${id}`);
    vi.mocked(fetch).mockResolvedValue(Response.json({continuation_id: id, state: "awaiting_previous_sign_in"}));
    render(<AuthProvider><AgentRuntimeStateProvider><PhoneMandatePageContent /></AgentRuntimeStateProvider></AuthProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Use a different number" }));
    // Back to phone entry; another account cannot delete the phone's holder.
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
