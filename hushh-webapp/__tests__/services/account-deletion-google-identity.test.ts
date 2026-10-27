import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  auth: { currentUser: null as any },
  grant: vi.fn(),
  reauthenticate: vi.fn(),
  popup: vi.fn(),
  signIn: vi.fn(),
  signInPopup: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("@capacitor/core", async (original) => ({
  ...await original<typeof import("@capacitor/core")>(),
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
}));
vi.mock("firebase/auth", async (original) => ({
  ...await original<typeof import("firebase/auth")>(),
  reauthenticateWithCredential: ports.reauthenticate,
  reauthenticateWithPopup: ports.popup,
  signInWithCredential: ports.signIn,
  signInWithPopup: ports.signInPopup,
  signOut: ports.signOut,
}));
vi.mock("@/lib/firebase/config", () => ({ auth: ports.auth, app: {} }));
vi.mock("@/lib/capacitor", () => ({ HushhAuth: {} }));
vi.mock("@capacitor-firebase/authentication", () => ({ FirebaseAuthentication: {}, ProviderId: { PHONE: "phone" } }));
vi.mock("@/lib/notifications/fcm-service", () => ({ clearLocalChatNotificationState: vi.fn() }));
vi.mock("@/lib/auth/google-signup-token", () => ({
  requestGoogleSignupToken: ports.grant,
  googleSignupConfigured: () => Boolean(process.env.NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID),
}));

import { GoogleAuthProvider } from "firebase/auth";
import { AuthService } from "@/lib/services/auth-service";

describe("account deletion Google credential reauthentication", () => {
  const grant = { accessToken: "synthetic-google-grant", contactsGranted: false };
  const credential = { providerId: "google.com", signInMethod: "google.com" };
  const verify = (current = () => true) => AuthService.reauthenticateAccountDeletionIdentity("recipient", "google.com", current);
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID", "synthetic-client-id");
    ports.auth.currentUser = {
      uid: "recipient", providerData: [{ providerId: "google.com" }],
      getIdToken: vi.fn().mockResolvedValue("fresh-firebase-proof"),
    };
    ports.grant.mockResolvedValue(grant);
    vi.spyOn(GoogleAuthProvider, "credential").mockReturnValue(credential as never);
    ports.reauthenticate.mockResolvedValue({ user: ports.auth.currentUser });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("starts an identity-only grant in the gesture and reauthenticates without replacement sign-in", async () => {
    const pending = verify();
    const gestureCalls = [...ports.grant.mock.calls];
    await expect(pending).resolves.toBe("fresh-firebase-proof");
    expect(gestureCalls).toEqual([[{ includeContacts: false }]]);
    expect(GoogleAuthProvider.credential).toHaveBeenCalledWith(null, grant.accessToken);
    expect(ports.reauthenticate).toHaveBeenCalledWith(ports.auth.currentUser, credential);
    expect(ports.auth.currentUser.getIdToken).toHaveBeenCalledWith(true);
    expect(ports.popup).not.toHaveBeenCalled();
    expect(ports.signIn).not.toHaveBeenCalled();
    expect(ports.signInPopup).not.toHaveBeenCalled();
    expect(ports.signOut).not.toHaveBeenCalled();
  });

  it.each([
    ["auth/user-mismatch", "identity_mismatch"],
    ["auth/invalid-credential", "identity_verification_failed"],
  ])("rejects credential exchange failure %s before reading a token", async (code, expected) => {
    ports.reauthenticate.mockRejectedValueOnce({ code, message: "private-provider-value" });
    await expect(verify()).rejects.toThrow(expected);
    expect(ports.auth.currentUser.getIdToken).not.toHaveBeenCalled();
    expect(ports.signIn).not.toHaveBeenCalled();
    expect(ports.popup).not.toHaveBeenCalled();
  });

  it.each([
    ["auth/initialization-not-ready", "identity_initialization_not_ready"],
    ["auth/popup-blocked", "identity_popup_blocked"],
    ["auth/popup-closed-by-user", "identity_cancelled"],
    ["auth/timeout", "identity_timeout"],
  ])("redacts grant failure %s without opening another popup", async (code, expected) => {
    ports.grant.mockRejectedValueOnce({ code, message: "private-provider-value" });
    await expect(verify()).rejects.toThrow(expected);
    expect(ports.reauthenticate).not.toHaveBeenCalled();
    expect(ports.popup).not.toHaveBeenCalled();
    expect(ports.auth.currentUser.getIdToken).not.toHaveBeenCalled();
  });

  it.each(["grant", "exchange", "refresh"])("rejects owner changes during %s", async (stage) => {
    let current = true;
    if (stage === "grant") ports.grant.mockImplementationOnce(async () => {
      ports.auth.currentUser = { ...ports.auth.currentUser }; // Same UID, new session.
      return grant;
    });
    if (stage === "exchange") ports.reauthenticate.mockImplementationOnce(async () => {
      current = false;
      return { user: ports.auth.currentUser };
    });
    if (stage === "refresh") ports.auth.currentUser.getIdToken.mockImplementationOnce(async () => {
      current = false;
      return "must-not-escape";
    });
    await expect(verify(() => current)).rejects.toThrow("session_changed");
    if (stage === "grant") expect(ports.reauthenticate).not.toHaveBeenCalled();
    if (stage !== "refresh") expect(ports.auth.currentUser.getIdToken).not.toHaveBeenCalled();
    expect(ports.signIn).not.toHaveBeenCalled();
  });

  it("retains shared verification's existing transport without GIS preloading", async () => {
    ports.popup.mockResolvedValueOnce({ user: ports.auth.currentUser });
    await expect(AuthService.reauthenticateGoogleIdentity("recipient", () => true)).resolves.toBe("fresh-firebase-proof");
    expect(ports.popup).toHaveBeenCalledTimes(1);
    expect(ports.grant).not.toHaveBeenCalled();
    expect(ports.reauthenticate).not.toHaveBeenCalled();
  });
});
