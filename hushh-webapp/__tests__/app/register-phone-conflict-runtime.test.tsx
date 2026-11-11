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
    mocks.phoneLinkConfirm.mockImplementationOnce(async ({ onConflictProof }) => {
      onConflictProof("verified-conflict-proof");
      throw Object.assign(new Error("Phone held"), { code: "credential-already-in-use" });
    });
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
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
    expect(mocks.identityClaim).not.toHaveBeenCalled();
    expect(mocks.phoneFinalize).not.toHaveBeenCalled();
    expect(mocks.phoneLinkConfirm).toHaveBeenCalledOnce();
    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });

  it("requires explicit fresh SMS when ordinary linking succeeds but the app claim conflicts", async () => {
    render(<AuthProvider><AgentRuntimeStateProvider><PhoneMandatePageContent /></AgentRuntimeStateProvider></AuthProvider>);
    const phone = await screen.findByRole("textbox", { name: "Phone number" });
    fireEvent.change(phone, { target: { value: "6505550101" } });
    fireEvent.submit(phone.closest("form")!);
    const code = await screen.findByRole("textbox", { name: "One-time code" });
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.submit(code.closest("form")!);
    expect(await screen.findByRole("button", { name: "Use this number on this account" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send a real SMS code" })).toBeEnabled();
    expect(mocks.phoneFinalize).toHaveBeenCalledOnce();
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
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
  it.each([false, true])("settles linked deletion without reusing SMS or replaying an uncertain confirmation (lost ACK: %s)", async (lostAck) => {
    const operation = "d2a5e0f0-8c5e-4f2c-9a51-3f0d6b5f9a11";
    const bodies: Record<string, unknown>[] = [];
    let claims = 0;
    let confirmations = 0;
    let reconciled = false;
    const identity = await vi.importActual<typeof import("@/lib/services/account-identity-service")>("@/lib/services/account-identity-service");
    const api = await vi.importActual<typeof import("@/lib/services/api-service")>("@/lib/services/api-service");
    Object.assign(ApiService, { claimAccountPhone: api.ApiService.claimAccountPhone });
    mocks.identityClaim.mockImplementation(identity.AccountIdentityService.claimCurrentUserPhone.bind(identity.AccountIdentityService));
    mocks.phoneLinkConfirm.mockImplementation(async ({ onConflictProof }) => {
      onConflictProof("phone-id-token");
      throw Object.assign(new Error("Phone is held by another Firebase identity"), { code: "auth/credential-already-in-use" });
    });
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const path = String(url);
      if (init?.body) bodies.push({ path, ...JSON.parse(String(init.body)) });
      if (path.endsWith("/phone/linked-account/deletions")) {
        return Response.json({ operation_id: operation, state: "prepared", expires_at: "2099-01-01T00:00:00Z", phone_hint: "••01", transport: "sms" });
      }
      if (path.endsWith("/phone/linked-account/deletions/confirm")) {
        confirmations += 1;
        if (lostAck) throw new TypeError("confirmation response lost");
        return Response.json({ operation_id: operation, state: "admitted" });
      }
      if (path.endsWith(`/phone/linked-account/deletions/${operation}`)) {
        return Response.json({ operation_id: operation, state: reconciled ? "admitted" : "prepared" });
      }
      if (path.endsWith("/phone/claim") && ++claims === 1) {
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
    if (lostAck) {
      const check = await screen.findByRole("button", { name: "Check again" }, { timeout: 5_000 });
      reconciled = true;
      fireEvent.click(check);
    }
    await screen.findByText("Deletion requested. Verify this number again to continue.");
    expect(confirmations).toBe(1);
    expect(claims).toBe(0);
    expect(bodies.find(body => String(body.path).endsWith("/deletions/confirm"))).toEqual({
      path: "/api/account/phone/linked-account/deletions/confirm", operation_id: operation,
      phone_number: "+16505550101", confirmed: true, phone_id_token: "phone-id-token",
    });
    // The provider-conflict proof authorizes deletion only; linking needs fresh verification.
    expect(mocks.phoneLinkConfirm).toHaveBeenCalledOnce();
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
    expect(bodies.some(body => String(body.path).endsWith("/phone/recovery/continuations"))).toBe(false);
    expect(mocks.replaceDocument).not.toHaveBeenCalled();
  }, 10_000);
  it.each(["manual", "instant", "retry save"] as const)("keeps Dev's explicit %s SMS recovery and owner-approved transfer for a partially saved phone", async proofMode => {
    const identity = await vi.importActual<typeof import("@/lib/services/account-identity-service")>("@/lib/services/account-identity-service");
    const api = await vi.importActual<typeof import("@/lib/services/api-service")>("@/lib/services/api-service");
    const { AuthService } = await import("@/lib/services/auth-service");
    const { AccountIdentityService } = await import("@/lib/services/account-identity-service");
    mocks.firebaseUser = makeUser("account-owner", "+16505550101");
    const sendProof = vi.fn().mockResolvedValue(proofMode === "instant" ? { phoneIdToken: "fresh-recovery-proof" } : { verificationId: "fresh-proof-challenge" });
    const confirmProof = vi.fn().mockResolvedValue("fresh-recovery-proof");
    Object.assign(AuthService, { startPhoneDeletionVerification: sendProof, confirmPhoneDeletionVerification: confirmProof });
    Object.assign(ApiService, { claimAccountPhone: api.ApiService.claimAccountPhone, phoneTransferRequest: api.ApiService.phoneTransferRequest });
    Object.assign(AccountIdentityService, { transferCurrentUserPhone: identity.AccountIdentityService.transferCurrentUserPhone.bind(identity.AccountIdentityService) });
    mocks.identityClaim.mockImplementation(identity.AccountIdentityService.claimCurrentUserPhone.bind(identity.AccountIdentityService));
    const bodies: { path: string; [key: string]: unknown }[] = [];
    let claims = 0;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const path = String(url);
      if (init?.body) bodies.push({ path, ...JSON.parse(String(init.body)) });
      if (path.endsWith("/phone/claim") && ++claims === 1 && proofMode === "retry save") return Response.json({ detail: { code: "PHONE_IDENTITY_SAVE_FAILED" } }, { status: 503 });
      if (path.endsWith("/phone/transfer/prepare")) return Response.json({ transfer_id: "verified-transfer" });
      if (path.endsWith("/phone/transfer/confirm")) return Response.json({ transfer_status: "completed", identity: {
        user_id: "account-owner", phone_verified: true, phone_number: "+16505550101",
      } });
      return Response.json({ detail: { code: "PHONE_TRANSFER_CONFIRMATION_REQUIRED" } }, { status: 409 });
    });
    render(<AuthProvider><AgentRuntimeStateProvider><PhoneMandatePageContent /></AgentRuntimeStateProvider></AuthProvider>);
    const phone = await screen.findByRole("textbox", { name: "Phone number" });
    fireEvent.change(phone, { target: { value: "6505550101" } });
    fireEvent.submit(phone.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Send a real SMS code" }));
    if (proofMode !== "instant") {
      const code = await screen.findByRole("textbox", { name: "One-time code" });
      fireEvent.change(code, { target: { value: "123456" } });
      fireEvent.submit(code.closest("form")!);
      if (proofMode === "retry save") {
        await waitFor(() => expect(claims).toBe(1));
        await waitFor(() => expect(code.closest("form")!.querySelector('button[type="submit"]')).not.toBeDisabled());
        fireEvent.submit(code.closest("form")!);
      }
    }
    fireEvent.click(await screen.findByRole("button", { name: "Use this number on this account" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm phone transfer" }));
    await waitFor(() => expect(bodies.some(body => body.path.endsWith("/phone/transfer/confirm"))).toBe(true));
    expect(bodies.filter(body => body.path.includes("/phone/transfer/"))).toEqual([
      { path: "/api/account/phone/transfer/prepare", phone_id_token: "fresh-recovery-proof", expected_user_id: "account-owner" },
      { path: "/api/account/phone/transfer/confirm", phone_id_token: "fresh-recovery-proof", expected_user_id: "account-owner", transfer_id: "verified-transfer", confirmed: true },
    ]);
    expect(sendProof).toHaveBeenCalledOnce();
    expect(confirmProof).toHaveBeenCalledTimes(proofMode === "instant" ? 0 : 1);
    expect(mocks.phoneLinkStart).not.toHaveBeenCalled();
    expect(mocks.phoneLinkConfirm).not.toHaveBeenCalled();
    expect(bodies.some(body => body.path.includes("/deletions"))).toBe(false);
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
