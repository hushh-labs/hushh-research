import { describe, expect, it, vi } from "vitest";

import {
  AUTH_SESSION_INVALIDATED_EVENT,
  AUTH_SESSION_SIBLING_TAB_STORAGE_KEY,
  authSessionInvalidationFromSiblingTabStorageEvent,
  authSessionInvalidationCodeFromBackendPayload,
  authSessionInvalidationCodeFromFirebaseError,
  buildLoginRouteWithAuthSessionNotice,
  dispatchAuthSessionInvalidated,
  getAuthSessionLandingNotice,
  isAccountDeletionInProgressBackendPayload,
  loginRouteWithoutAuthSessionNotice,
  publishAccountDeletionToSiblingTabs,
  readAuthSessionLandingNotice,
} from "@/lib/auth/session-invalidation";

describe("auth session invalidation contract", () => {
  it("carries only a typed reason code and request path on the canonical event", () => {
    const listener = vi.fn();
    window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);

    expect(
      dispatchAuthSessionInvalidated({
        code: "account_not_found",
        path: "/api/v1/vault/bootstrap-state",
      }),
    ).toBe(true);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toBeInstanceOf(CustomEvent);
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      code: "account_not_found",
      path: "/api/v1/vault/bootstrap-state",
    });

    window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
  });

  it("builds and reads a sanitized account-not-found login notice", () => {
    const route = buildLoginRouteWithAuthSessionNotice("account_not_found");
    const params = new URL(route, "https://one.hushh.ai").searchParams;

    expect(route).toBe("/login?auth_notice=account_not_found");
    expect(readAuthSessionLandingNotice(params)).toEqual({
      code: "account_not_found",
      message: "Account not found. Redirecting you to login screen.",
      toastId: "auth-session-account-not-found",
    });
  });

  it("gives the initiating client a confirmed deletion success notice", () => {
    const route = buildLoginRouteWithAuthSessionNotice("account_deleted");
    const params = new URL(route, "https://one.hushh.ai").searchParams;

    expect(route).toBe("/login?auth_notice=account_deleted");
    expect(readAuthSessionLandingNotice(params)).toEqual({
      code: "account_deleted",
      message: "Account deleted. You have been securely signed out.",
      toastId: "auth-session-account-deleted",
    });
  });

  it("builds an explicit fail-closed notice for an uncertain deletion outcome", () => {
    const route = buildLoginRouteWithAuthSessionNotice(
      "account_deletion_uncertain",
    );
    const params = new URL(route, "https://one.hushh.ai").searchParams;

    expect(route).toBe("/login?auth_notice=account_deletion_uncertain");
    expect(readAuthSessionLandingNotice(params)).toEqual({
      code: "account_deletion_uncertain",
      message:
        "We couldn't confirm whether account deletion finished. For your security, we signed you out and won't retry it automatically. Please check your connection before signing in again.",
      toastId: "auth-session-account-deletion-uncertain",
    });
  });

  it("rejects unknown query values instead of surfacing arbitrary text", () => {
    expect(getAuthSessionLandingNotice("raw backend failure text")).toBeNull();
    expect(
      readAuthSessionLandingNotice(
        new URLSearchParams("auth_notice=raw+backend+failure+text"),
      ),
    ).toBeNull();
  });

  it("finds the account-not-found code in direct, native, and proxied payloads", () => {
    expect(
      authSessionInvalidationCodeFromBackendPayload({
        detail: {
          code: "AUTH_ACCOUNT_NOT_FOUND",
          message: "Account not found",
        },
      }),
    ).toBe("account_not_found");

    expect(
      authSessionInvalidationCodeFromBackendPayload({
        data: JSON.stringify({
          detail: { code: "AUTH_ACCOUNT_NOT_FOUND" },
        }),
      }),
    ).toBe("account_not_found");

    expect(
      authSessionInvalidationCodeFromBackendPayload({
        error: {
          response: {
            body: { detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } },
          },
        },
      }),
    ).toBe("account_not_found");
  });

  it("bounds malformed payload traversal and requires an exact backend code", () => {
    const cyclic: Record<string, unknown> = {
      message: "Request mentioned AUTH_ACCOUNT_NOT_FOUND but did not return it",
    };
    cyclic.self = cyclic;

    expect(authSessionInvalidationCodeFromBackendPayload(cyclic)).toBeNull();

    let tooDeep: unknown = "AUTH_ACCOUNT_NOT_FOUND";
    for (let index = 0; index < 8; index += 1) {
      tooDeep = { detail: tooDeep };
    }
    expect(authSessionInvalidationCodeFromBackendPayload(tooDeep)).toBeNull();
  });

  it("recognizes only the exact account-deletion lifecycle-lock code", () => {
    expect(
      isAccountDeletionInProgressBackendPayload({
        detail: {
          code: "AUTH_ACCOUNT_DELETION_IN_PROGRESS",
          message: "Account deletion is in progress.",
        },
      }),
    ).toBe(true);
    expect(
      isAccountDeletionInProgressBackendPayload({
        detail:
          "Request mentioned AUTH_ACCOUNT_DELETION_IN_PROGRESS without a code",
      }),
    ).toBe(false);
    expect(
      authSessionInvalidationCodeFromBackendPayload({
        detail: { code: "AUTH_ACCOUNT_DELETION_IN_PROGRESS" },
      }),
    ).toBeNull();
  });

  it.each([
    { code: "auth/user-not-found" },
    { message: "There is no user record for this identifier." },
    { message: "The user may have been deleted." },
  ])("maps a deleted Firebase identity to account_not_found", (error) => {
    expect(authSessionInvalidationCodeFromFirebaseError(error)).toBe(
      "account_not_found",
    );
  });

  it.each([
    "auth/user-disabled",
    "auth/invalid-user-token",
    "auth/user-token-expired",
    "auth/id-token-revoked",
    "The user's credential is no longer valid. Please sign in again.",
  ])(
    "maps terminal Firebase session failure %s to session_invalid",
    (value) => {
      expect(
        authSessionInvalidationCodeFromFirebaseError({ code: value }),
      ).toBe("session_invalid");
    },
  );

  it("walks a bounded Firebase cause chain and tolerates cycles", () => {
    expect(
      authSessionInvalidationCodeFromFirebaseError({
        message: "Authentication failed",
        cause: { code: "ERROR_USER_NOT_FOUND" },
      }),
    ).toBe("account_not_found");

    const cyclic: { message: string; cause?: unknown } = {
      message: "Unknown Firebase failure",
    };
    cyclic.cause = cyclic;
    expect(authSessionInvalidationCodeFromFirebaseError(cyclic)).toBeNull();

    let tooDeep: unknown = { code: "auth/user-disabled" };
    for (let index = 0; index < 6; index += 1) {
      tooDeep = { cause: tooDeep };
    }
    expect(authSessionInvalidationCodeFromFirebaseError(tooDeep)).toBeNull();
  });

  it.each([
    { code: "auth/network-request-failed" },
    { message: "The request timed out" },
    { code: "auth/internal-error", message: "Unknown Firebase failure" },
    {
      code: "auth/network-request-failed",
      cause: { code: "auth/user-not-found" },
    },
  ])("does not classify transient or unknown Firebase failures", (error) => {
    expect(authSessionInvalidationCodeFromFirebaseError(error)).toBeNull();
  });

  it("removes only the one-shot notice and preserves redirect intent", () => {
    const cleaned = loginRouteWithoutAuthSessionNotice(
      new URLSearchParams(
        "redirect=%2Fone%2Ffeed&auth_notice=account_not_found",
      ),
    );

    expect(cleaned).toBe("/login?redirect=%2Fone%2Ffeed");
  });

  it("publishes an ephemeral, UID-scoped account-deletion signal for sibling tabs", () => {
    const storagePrototype = Object.getPrototypeOf(
      window.localStorage,
    ) as Storage;
    const setItem = vi.spyOn(storagePrototype, "setItem");
    const removeItem = vi.spyOn(storagePrototype, "removeItem");

    try {
      expect(publishAccountDeletionToSiblingTabs(" account-owner ")).toBe(true);

      expect(setItem).toHaveBeenCalledTimes(1);
      expect(removeItem).toHaveBeenCalledWith(
        AUTH_SESSION_SIBLING_TAB_STORAGE_KEY,
      );
      const [key, payload] = setItem.mock.calls[0]!;
      expect(key).toBe(AUTH_SESSION_SIBLING_TAB_STORAGE_KEY);
      expect(
        authSessionInvalidationFromSiblingTabStorageEvent({
          key,
          newValue: payload,
        }),
      ).toEqual({
        code: "account_not_found",
        path: "account_deleted_in_sibling_tab",
        userId: "account-owner",
      });
    } finally {
      setItem.mockRestore();
      removeItem.mockRestore();
    }
  });

  it("rejects malformed or unrelated sibling-tab storage signals", () => {
    expect(
      authSessionInvalidationFromSiblingTabStorageEvent({
        key: "another-key",
        newValue: "{}",
      }),
    ).toBeNull();
    expect(
      authSessionInvalidationFromSiblingTabStorageEvent({
        key: AUTH_SESSION_SIBLING_TAB_STORAGE_KEY,
        newValue: JSON.stringify({
          version: 1,
          eventId: "event-1",
          occurredAtMs: Date.now(),
          detail: { code: "session_invalid", userId: "account-owner" },
        }),
      }),
    ).toBeNull();
  });

  it("rejects expired and replayed sibling-tab deletion signals", () => {
    const key = AUTH_SESSION_SIBLING_TAB_STORAGE_KEY;
    const expired = JSON.stringify({
      version: 1,
      eventId: "expired-event",
      occurredAtMs: Date.now() - 31_000,
      detail: { code: "account_not_found", userId: "account-owner" },
    });
    expect(
      authSessionInvalidationFromSiblingTabStorageEvent({
        key,
        newValue: expired,
      }),
    ).toBeNull();

    const current = JSON.stringify({
      version: 1,
      eventId: "one-shot-event",
      occurredAtMs: Date.now(),
      detail: { code: "account_not_found", userId: "account-owner" },
    });
    expect(
      authSessionInvalidationFromSiblingTabStorageEvent({
        key,
        newValue: current,
      }),
    ).not.toBeNull();
    expect(
      authSessionInvalidationFromSiblingTabStorageEvent({
        key,
        newValue: current,
      }),
    ).toBeNull();
  });
});
