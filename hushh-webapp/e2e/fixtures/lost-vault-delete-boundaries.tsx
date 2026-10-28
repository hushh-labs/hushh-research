// Inert identity/SMS/backend ports. Production panel, account service, deletion
// flow, session owner, AuthProvider and login notices execute unchanged.
import React from "react";
import {
  ApiService as sessionPorts,
  AuthService as authPorts,
  CacheSyncService as cachePorts,
  UserLocalStateService as statePorts,
} from "./profile-sign-out-boundaries";
export * from "./profile-sign-out-boundaries";
const record = (event: string) => {
  void (
    window as unknown as {
      recordSignOutEvent: (event: string) => Promise<void>;
    }
  ).recordSignOutEvent(event);
};
export const Capacitor = {
  isNativePlatform: () => new URLSearchParams(window.location.search).get("native") === "1",
  getPlatform: () => new URLSearchParams(window.location.search).get("native") === "1" ? "android" : "web",
  isPluginAvailable: () => false,
};
export const registerPlugin = () => ({});
export class WebPlugin {}
export const usePathname = () => window.location.pathname;
export const useSearchParams = () =>
  new URLSearchParams(window.location.search);
export const useRouter = () => ({
  replace: () => undefined,
  push: () => undefined,
});
export const usePublishVoiceSurfaceMetadata = () => undefined;
export const useLocalOnboardingActionHandler = () => undefined;
export const NativeRouteMarker = () => null;
export const AuthStep = () => (
  <p>Sign-in transport disabled in this fixture.</p>
);
export const trackEvent = () => undefined;
export const HushhAccount = {};
export const VaultService = {};
export const toast = Object.assign(() => undefined, {
  error: () => undefined,
  success: () => undefined,
  info: () => undefined,
  dismiss: () => undefined,
});
export const AuthService = {
  ...authPorts,
  restoreNativeSession: async () => authPorts.getCurrentUser(),
  reauthenticateAccountDeletionIdentity: async () => {
    record("provider-verified");
    return "synthetic-provider-proof";
  },
  startPhoneDeletionVerification: async () => {
    record("sms-requested");
    return { verificationId: "synthetic-sms-session" };
  },
  cancelPhoneDeletionVerification: async () => {},
  confirmPhoneDeletionVerification: async ({
    verificationCode,
  }: {
    verificationCode: string;
  }) => {
    if (verificationCode !== "123456")
      throw Object.assign(new Error("Wrong code"), {
        code: "auth/invalid-verification-code",
      });
    record("phone-verified");
    return "synthetic-phone-proof";
  },
};
export const CacheSyncService = {
  ...cachePorts,
  onAccountDeleted: () => record("deleted-cache-cleared"),
};
export const UserLocalStateService = {
  ...statePorts,
  clearDeviceSecretsForDeletedAccount: async () =>
    record("device-secrets-cleared"),
};
export const ApiService = {
  getAccountSessionStatus: sessionPorts.getAccountSessionStatus,
  deleteSession: async () => record("cookie-cleared"),
  apiFetch: async (path: string, options: RequestInit = {}) => {
    if (path === "/api/account/delete-lost-vault/options")
      return Response.json({
        phone_available: true,
        phone_hint: "••00",
        providers: ["google.com"],
      });
    const body = JSON.parse(String(options.body || "{}"));
    if (path === "/api/account/delete-lost-vault/phone") {
      if (body.phone_number !== "+16505550100") {
        record("preflight-rejected");
        return Response.json(
          { detail: { code: "ACCOUNT_DELETE_PHONE_MISMATCH" } },
          { status: 403 },
        );
      }
      record("preflight-accepted");
      return Response.json({ valid: true });
    }
    if (path === "/api/account/delete-lost-vault/review") {
      if (body.phone_id_token !== "synthetic-phone-proof" || body.method !== "phone")
        throw new Error("Missing review proof");
      record("provider-inventory-reviewed");
      return Response.json({
        inventory_sha256: "a".repeat(64),
        credential_count: 1,
        local_erasure_required: true,
      });
    }
    if (path === "/api/account/delete-lost-vault") {
      if (
        body.phone_id_token !== "synthetic-phone-proof" ||
        body.method !== "phone" ||
        body.reviewed_inventory_sha256 !== "a".repeat(64) ||
        body.accept_local_erasure !== true
      )
        throw new Error("Missing reviewed deletion consent");
      record("deletion-submitted");
      const outcome =
        new URLSearchParams(window.location.search).get("outcome") ||
        "identity_retained";
      if (outcome === "pending")
        return Response.json({
          success: true,
          account_deleted: false,
          cleanup_pending: true,
          cleanup_operation: {
            id: "11111111-1111-1111-1111-111111111111",
            owner_id: "sign-out-fixture",
            state: "cleaning_up",
            credential_count: 1,
            local_erasure_confirmation_required: false,
          },
        }, { status: 202 });
      return Response.json({
        success: true,
        account_deleted: true,
        ready_to_start_fresh: outcome === "deleted",
        details: { firebase_auth_user: outcome },
      });
    }
    throw new Error("Unexpected fixture request");
  },
};
export const getSessionItem = () => null;
export const getLocalItem = () => null;
export const setSessionItem = () => undefined;
export const setLocalItem = () => undefined;
export const removeSessionItem = () => undefined;
export const nativeDocumentId = () => "fixture-document";
const privacy = { shielded: false, generation: 0 };
export const nativePrivacyObservation = () => privacy;
export const subscribeNativePrivacyObservation = () => () => undefined;
export const HushhPersonalKnowledgeModel = {};
export const setConfig = () => undefined;
