import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  auth: {
    user: null as null | { uid: string; getIdToken: () => Promise<string> },
    userId: null as string | null,
    loading: false,
  },
  completeOAuth: vi.fn(),
  completeWeb: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "synthetic-owner-token", vaultKey: "synthetic-key", ownerTokenStatus: "ready" }),
}));
vi.mock("@/components/vault/vault-lock-guard", () => ({
  VaultLockGuard: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: { completeOAuthConnect: mocks.completeOAuth, completeWebOAuth: mocks.completeWeb },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(),
}));

import Callback from "@/app/one/profile/connectors/oauth/return/page";
import { saveCuratedConnectorSettingsHandoff } from "@/lib/agent/drive-oauth-chat-recovery";
import { markMeetingReviewOAuthReturn, meetingReviewReturnHref, readMeetingReviewOAuthReturn } from "@/lib/consent/meeting-review-return";
import { buildConnectorSignInReturnHref } from "@/lib/navigation/profile-pane";

const ATTEMPT = "attempt-abcdefghijklmnopqrstuvwxyz0123456789";
const REQUEST = "request-0123456789";
const driveHandoff = (ownerUserId = "owner-a") => window.sessionStorage.setItem("one_drive_chat_recovery_handoff_v1", JSON.stringify({
  version: 1, ownerUserId, attemptId: ATTEMPT, reason: "web_full_page",
  expiresAt: Date.now() + 60_000, returnTo: "connector_settings",
}));

describe("full-page Drive authorization from a meeting-file request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth = { user: { uid: "owner-a", getIdToken: async () => "firebase-token" }, userId: "owner-a", loading: false };
    mocks.completeWeb.mockResolvedValue({ connectorId: "google_drive", status: "connected" });
    window.history.replaceState(null, "", "/one/profile/connectors/oauth/return?code=secret-code&state=signed-state");
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    // eslint-disable-next-line no-restricted-globals -- Clear the synthetic handoff marker.
    sessionStorage.clear();
    window.localStorage.clear();
  });

  it("returns the organizer to the exact request, not the connections screen, and uses the context once", async () => {
    driveHandoff();
    markMeetingReviewOAuthReturn("owner-a", REQUEST);
    render(<Callback />);
    await screen.findByText("Connected. Taking you back…");
    expect(mocks.completeWeb).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ attemptId: ATTEMPT, code: "secret-code", state: "signed-state" }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(meetingReviewReturnHref(REQUEST)), { timeout: 4000 });
    expect(mocks.replace).not.toHaveBeenCalledWith(buildConnectorSignInReturnHref("connector_settings"));
    expect(readMeetingReviewOAuthReturn("owner-a")).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("returns there even when the sign-in failed, so the organizer can try again from the request", async () => {
    driveHandoff();
    markMeetingReviewOAuthReturn("owner-a", REQUEST);
    mocks.completeWeb.mockRejectedValue(new Error("exchange failed"));
    render(<Callback />);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(meetingReviewReturnHref(REQUEST)), { timeout: 4000 });
  });

  it("keeps the connections destination when nothing started from a request", async () => {
    driveHandoff();
    render(<Callback />);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(buildConnectorSignInReturnHref("connector_settings")), { timeout: 4000 });
  });

  it("ignores another account's request context", async () => {
    driveHandoff();
    markMeetingReviewOAuthReturn("owner-b", REQUEST);
    render(<Callback />);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(buildConnectorSignInReturnHref("connector_settings")), { timeout: 4000 });
    expect(readMeetingReviewOAuthReturn("owner-b")).toEqual({ requestId: REQUEST });
  });

  it("never redirects a different connector's sign-in to a meeting request", async () => {
    saveCuratedConnectorSettingsHandoff({ ownerUserId: "owner-a", attemptId: ATTEMPT, curatedConnector: { connectorId: "hubspot" } });
    mocks.completeOAuth.mockResolvedValue({ connectorId: "hubspot", status: "connected" });
    markMeetingReviewOAuthReturn("owner-a", REQUEST);
    render(<Callback />);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(mocks.replace).not.toHaveBeenCalledWith(meetingReviewReturnHref(REQUEST));
    expect(readMeetingReviewOAuthReturn("owner-a")).toEqual({ requestId: REQUEST });
  });
});
