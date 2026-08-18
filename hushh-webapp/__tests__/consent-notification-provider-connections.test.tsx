/**
 * Regression coverage for issue #5422.
 *
 * The connection-request toast rendered "Someone wants to connect with you on
 * hushh." for every incoming request: the FCM data map never carried a
 * `requester_label`, and the sentence was a hand-authored JSX literal that kept
 * the pre-rebrand spelling. There was no test on this branch at all, which is
 * why both defects survived.
 *
 * The platform matrix matters here and is asserted below: iOS presents its own
 * system banner while foregrounded, so an in-app toast would duplicate it;
 * Android presents no foreground banner, so it owns the toast.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { dismiss: vi.fn() });
  const user = {
    uid: "recipient-user",
    getIdToken: vi.fn().mockResolvedValue("firebase-token"),
  };
  return {
    toast,
    user,
    auth: { user: user as typeof user | null },
    routerPush: vi.fn(),
    routerReplace: vi.fn(),
    platform: { value: "web", native: false },
    initializeFCM: vi.fn(),
    prepareFCMListeners: vi.fn(),
    getState: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useRouter: () => ({ push: mocks.routerPush, replace: mocks.routerReplace }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => mocks.platform.native,
    getPlatform: () => mocks.platform.value,
  },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.auth.user }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: true,
    getVaultOwnerToken: () => "vault-owner-token",
  }),
}));

vi.mock("@/lib/consent", () => ({
  useConsentActions: () => ({ handleDeny: vi.fn() }),
}));

vi.mock("@/lib/notifications", () => ({
  initializeFCM: mocks.initializeFCM,
  prepareFCMListeners: mocks.prepareFCMListeners,
  clearDeliveredConsentNotifications: vi.fn(),
  FCM_MESSAGE_EVENT: "fcm-message",
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: { getState: mocks.getState },
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getPendingConsents: vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ pending: [] }),
    }),
    markPendingConsentOpened: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/services/app-background-task-service", () => ({
  AppBackgroundTaskService: {
    startTask: vi.fn(),
    completeTask: vi.fn(),
    dismissTask: vi.fn(),
  },
}));

vi.mock("@/lib/morphy-ux/ui", () => ({ Icon: () => null }));

// The connection branch invalidates consent caches before it toasts; stub those
// collaborators so a cache/dispatch failure cannot be mistaken for a copy bug.
vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: {
    onConsentMutated: vi.fn(),
    onConsentReviewed: vi.fn(),
  },
}));

vi.mock("@/lib/consent/consent-events", () => ({
  CONSENT_STATE_CHANGED_EVENT: "consent-state-changed",
  dispatchConsentStateChanged: vi.fn(),
}));

import { ConsentNotificationProvider } from "@/components/consent/notification-provider";
import { BRAND_NAME } from "@/lib/branding/brand";

const EMPTY_LOCATION_STATE = {
  recipients: [],
  ownerGrants: [],
  receivedGrants: [],
  requests: [],
  referrals: [],
  publicInvites: [],
  networkConnections: [],
  publicInviteSubmissions: [],
  capabilityScopes: [],
};

async function renderProvider() {
  const result = render(
    <ConsentNotificationProvider>
      <div>Settings page</div>
    </ConsentNotificationProvider>,
  );
  await waitFor(() => expect(mocks.initializeFCM).toHaveBeenCalledOnce());
  return result;
}

function dispatchConnectionRequest(data: Record<string, string>) {
  act(() => {
    window.dispatchEvent(
      new CustomEvent("fcm-message", {
        detail: { data: { type: "connection_request", ...data } },
      }),
    );
  });
}

function renderedToast(index = 0) {
  const popup = mocks.toast.mock.calls[index]?.[0] as ReactNode;
  return render(<>{popup}</>);
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.clearAllMocks();
  mocks.auth.user = mocks.user;
  mocks.platform.native = false;
  mocks.platform.value = "web";
  mocks.prepareFCMListeners.mockResolvedValue(undefined);
  mocks.initializeFCM.mockResolvedValue({ status: "push_active" });
  mocks.getState.mockResolvedValue(EMPTY_LOCATION_STATE);
});

describe("connection-request toast copy", () => {
  it("names the requester and spells the brand Hussh", async () => {
    await renderProvider();

    dispatchConnectionRequest({
      requester_user_id: "user-rohan",
      requester_label: "Rohan Mehta",
      request_id: "conn-req-1",
    });

    expect(mocks.toast).toHaveBeenCalledTimes(1);
    renderedToast();
    expect(
      screen.getByText("Rohan Mehta wants to connect with you on Hussh."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Someone/)).not.toBeInTheDocument();
    expect(screen.queryByText(/on hushh\./)).not.toBeInTheDocument();
  });

  it("keeps the brand out of the pre-rebrand spelling even in the fallback", async () => {
    await renderProvider();

    dispatchConnectionRequest({ requester_user_id: "user-x", request_id: "conn-req-2" });

    renderedToast();
    // Unnamed is a legitimate outcome (a phone-only account has no display
    // name); the brand must still be right.
    expect(
      screen.getByText(`Someone wants to connect with you on ${BRAND_NAME}.`),
    ).toBeInTheDocument();
  });

  it("falls back to a contact handle before the generic line", async () => {
    await renderProvider();

    dispatchConnectionRequest({
      requester_user_id: "user-y",
      requester_email: "rohan@example.com",
      request_id: "conn-req-3",
    });

    renderedToast();
    expect(
      screen.getByText("rohan@example.com wants to connect with you on Hussh."),
    ).toBeInTheDocument();
  });

  it("never renders a raw user id as the requester name", async () => {
    await renderProvider();

    // actor_identity_cache.display_name is seeded to the user id for actors that
    // never synced from Firebase (migration 037), so this is a real payload.
    dispatchConnectionRequest({
      requester_user_id: "RPNmQAmVdlNz84GVfXxta50wnYx1",
      requester_label: "RPNmQAmVdlNz84GVfXxta50wnYx1",
      request_id: "conn-req-4",
    });

    renderedToast();
    expect(screen.queryByText(/RPNmQAmVdlNz84GVfXxta50wnYx1/)).not.toBeInTheDocument();
    expect(
      screen.getByText("Someone wants to connect with you on Hussh."),
    ).toBeInTheDocument();
  });

  it("treats a whitespace-only label as unnamed", async () => {
    await renderProvider();

    dispatchConnectionRequest({
      requester_user_id: "user-z",
      requester_label: "   ",
      request_id: "conn-req-5",
    });

    renderedToast();
    expect(
      screen.getByText("Someone wants to connect with you on Hussh."),
    ).toBeInTheDocument();
  });
});

describe("connection-request toast with the exact production payload", () => {
  // Captured from the real send_connection_request_push -> send_user_data_push ->
  // build_push_message chain (verified per platform in
  // consent-protocol/tests/test_fcm_messages.py). Every key the server actually
  // sends is present, so this catches a payload the client mishandles because of
  // a field the minimal fixtures omit.
  const PRODUCTION_DATA = {
    type: "connection_request",
    user_id: "recipient-user",
    request_url:
      "/one/consent?tab=pending&requestId=8f14e45f-ceea-467a-9c1d-5b8f0f9a1234",
    deep_link:
      "/one/consent?tab=pending&requestId=8f14e45f-ceea-467a-9c1d-5b8f0f9a1234",
    notification_tag: "connection-request:recipient-user",
    notification_category: "ONE_CONNECTIONS",
    requester_user_id: "requester-uid",
    requester_label: "Rohan Mehta",
    request_id: "8f14e45f-ceea-467a-9c1d-5b8f0f9a1234",
  };

  it("renders the requester's name and routes to their request", async () => {
    await renderProvider();

    dispatchConnectionRequest(PRODUCTION_DATA);

    expect(mocks.toast).toHaveBeenCalledTimes(1);
    renderedToast();
    expect(
      screen.getByText("Rohan Mehta wants to connect with you on Hussh."),
    ).toBeInTheDocument();

    screen.getByRole("button", { name: "View Request" }).click();
    const href = String(mocks.routerPush.mock.calls[0]?.[0] || "");
    expect(href).toContain("requestId=8f14e45f-ceea-467a-9c1d-5b8f0f9a1234");
  });

  it("drops a payload addressed to a different signed-in user", async () => {
    await renderProvider();

    dispatchConnectionRequest({ ...PRODUCTION_DATA, user_id: "someone-else" });

    expect(mocks.toast).not.toHaveBeenCalled();
  });
});

describe("connection-request toast routing", () => {
  it("opens the review sheet for the specific request", async () => {
    await renderProvider();

    dispatchConnectionRequest({
      requester_user_id: "user-rohan",
      requester_label: "Rohan",
      request_id: "conn-req-1",
      request_url: "/one/consent?tab=pending&requestId=conn-req-1",
    });

    renderedToast();
    screen.getByRole("button", { name: "View Request" }).click();

    expect(mocks.routerPush).toHaveBeenCalledTimes(1);
    const href = String(mocks.routerPush.mock.calls[0]?.[0] || "");
    expect(href).toContain("/one/consent");
    expect(href).toContain("requestId=conn-req-1");
  });

  it("makes the message itself tappable, not just the button", async () => {
    await renderProvider();

    dispatchConnectionRequest({
      requester_user_id: "user-rohan",
      requester_label: "Rohan",
      request_id: "conn-req-1",
      request_url: "/one/consent?tab=pending&requestId=conn-req-1",
    });

    renderedToast();
    screen
      .getByText("Rohan wants to connect with you on Hussh.")
      .closest("button")!
      .click();

    expect(mocks.routerPush).toHaveBeenCalledTimes(1);
  });
});

describe("connection-request toast de-duplication", () => {
  it("still toasts a second request from the same requester", async () => {
    await renderProvider();

    dispatchConnectionRequest({
      requester_user_id: "user-rohan",
      requester_label: "Rohan",
      request_id: "conn-req-1",
    });
    // Same person, new request — e.g. after the first was declined. The old key
    // was per-requester and never cleared, so this was silently swallowed.
    dispatchConnectionRequest({
      requester_user_id: "user-rohan",
      requester_label: "Rohan",
      request_id: "conn-req-2",
    });

    expect(mocks.toast).toHaveBeenCalledTimes(2);
  });

  it("shows one toast for a duplicate delivery of the same request", async () => {
    await renderProvider();

    const payload = {
      requester_user_id: "user-rohan",
      requester_label: "Rohan",
      request_id: "conn-req-1",
    };
    dispatchConnectionRequest(payload);
    dispatchConnectionRequest(payload);

    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });
});

describe("connection-request toast presentation policy", () => {
  it("suppresses the in-app toast on iOS, where the system banner already showed", async () => {
    mocks.platform.native = true;
    mocks.platform.value = "ios";
    await renderProvider();

    dispatchConnectionRequest({
      requester_user_id: "user-rohan",
      requester_label: "Rohan",
      request_id: "conn-req-1",
    });

    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("presents the in-app toast on Android, which shows no foreground banner", async () => {
    mocks.platform.native = true;
    mocks.platform.value = "android";
    await renderProvider();

    dispatchConnectionRequest({
      requester_user_id: "user-rohan",
      requester_label: "Rohan",
      request_id: "conn-req-1",
    });

    expect(mocks.toast).toHaveBeenCalledTimes(1);
    renderedToast();
    expect(
      screen.getByText("Rohan wants to connect with you on Hussh."),
    ).toBeInTheDocument();
  });
});
