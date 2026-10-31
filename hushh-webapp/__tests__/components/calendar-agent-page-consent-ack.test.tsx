import { mocks } from "../fixtures/calendar-agent-page";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CalendarAgentPage } from "@/components/calendar/calendar-agent-page";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";

describe("CalendarAgentPage consent window", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.native = false;
    mocks.authLoading = false;
    mocks.ownerId = "calendar-user";
    publishValidatedAuthSessionPrincipal({ firebaseUid: "calendar-user", ownerId: "calendar-user", accountGeneration: 0 });
    mocks.getPersonalAgentStatus.mockResolvedValue({ hostingMode: "shared" });
    mocks.popupAttempt = "";
    mocks.vaultOwnerToken = null;
    mocks.attendance = null;
    useOneConversationSession.getState().clearSession();
    mocks.getIdToken.mockResolvedValue("firebase-token");
    // Settling a consent window brings this page forward; jsdom does not implement focus.
    vi.spyOn(window, "focus").mockImplementation(() => undefined);
    vi.spyOn(window, "open").mockImplementation(
      () =>
        (mocks.popup = ({
          close: vi.fn(),
          document: { title: "" },
          focus: vi.fn(),
          location: { replace: vi.fn() },
          sessionStorage: {
            setItem: vi.fn((_key: string, value: string) => {
              mocks.popupAttempt = value;
            }),
            getItem: vi.fn(() => mocks.popupAttempt || null),
          },
        }) as unknown as Window),
    );
  });

  const waitForConsentWindow = () =>
    waitFor(() =>
      expect(
        (mocks.popup as unknown as { location: { replace: ReturnType<typeof vi.fn> } })
          .location.replace,
      ).toHaveBeenCalled(),
    );

  describe("acknowledging the consent window", () => {
    const ACK_KEY = "one_google_oauth_popup_ack_v1";
    const meetScopes = "https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/drive.meet.readonly https://www.googleapis.com/auth/drive.metadata.readonly";
    const account = (generation: string, scopeCsv = "") => ({
      account_id: "default", connected: true, status: "connected" as const, access_level: "read" as const,
      calendar_list_access: true, provider_subject_sha256: "a".repeat(64), grant_generation: generation, scope_csv: scopeCsv,
    });
    const initial = { configured: true, connected: true, status: "connected" as const,
      google_email: "initial@example.test", access_level: "read" as const, scope_csv: "", accounts: [account("old-A")] };
    const authorizeUrl = () => ({ authorize_url:
      `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(new URL("/one/profile/google/oauth/return", window.location.origin).href)}` });
    const ack = () => { const raw = window.localStorage.getItem(ACK_KEY); return raw ? JSON.parse(raw) as { attemptId: string } : null; };
    const settle = async (outcome: "succeeded" | "failed" | "cancelled") => {
      await waitForConsentWindow();
      const attempt = JSON.parse(mocks.popupAttempt) as { attemptId: string };
      await act(async () => window.dispatchEvent(new MessageEvent("message", {
        origin: window.location.origin, source: mocks.popup,
        data: { schemaVersion: 1, type: "google_oauth_settlement", attemptId: attempt.attemptId, service: "calendar", outcome },
      })));
      return attempt;
    };
    let focusPage: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      window.localStorage.removeItem(ACK_KEY);
      focusPage = vi.spyOn(window, "focus").mockImplementation(() => undefined);
      mocks.startConnect.mockResolvedValue(authorizeUrl());
    });
    afterEach(() => { window.localStorage.removeItem(ACK_KEY); });

    it("acknowledges a meeting-access settlement only after the new grant is verified here", async () => {
      let finishVerify!: (value: unknown) => void;
      mocks.status.mockResolvedValueOnce(initial);
      mocks.status.mockImplementationOnce(() => new Promise(resolve => { finishVerify = resolve; }));
      render(<CalendarAgentPage />);
      await screen.findByText("initial@example.test");
      fireEvent.click(screen.getByRole("button", { name: "Allow meeting files default" }));
      const attempt = await settle("succeeded");
      await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
      expect(ack()).toBeNull();
      await act(async () => finishVerify({ ...initial, accounts: [account("new-A", meetScopes)] }));
      await waitFor(() => expect(ack()?.attemptId).toBe(attempt.attemptId));
      // The original page brings itself forward once it has taken over.
      expect(focusPage).toHaveBeenCalled();
    });

    it("does not acknowledge a grant it could not verify as new", async () => {
      mocks.status.mockResolvedValueOnce(initial);
      // The same old generation comes back: nothing new was granted.
      mocks.status.mockResolvedValue(initial);
      render(<CalendarAgentPage />);
      await screen.findByText("initial@example.test");
      fireEvent.click(screen.getByRole("button", { name: "Allow meeting files default" }));
      await settle("succeeded");
      await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
      expect(ack()).toBeNull();
    });

    it.each(["failed", "cancelled"] as const)("acknowledges a %s settlement straight away so the window can say so", async outcome => {
      mocks.status.mockResolvedValue(initial);
      render(<CalendarAgentPage />);
      await screen.findByText("initial@example.test");
      fireEvent.click(screen.getByRole("button", { name: "Allow meeting files default" }));
      const attempt = await settle(outcome);
      await waitFor(() => expect(ack()?.attemptId).toBe(attempt.attemptId));
    });

    it("never acknowledges an attempt id that this page did not start", async () => {
      mocks.status.mockResolvedValue(initial);
      render(<CalendarAgentPage />);
      await screen.findByText("initial@example.test");
      fireEvent.click(screen.getByRole("button", { name: "Allow meeting files default" }));
      await waitForConsentWindow();
      await act(async () => window.dispatchEvent(new MessageEvent("message", {
        origin: window.location.origin, source: mocks.popup,
        data: { schemaVersion: 1, type: "google_oauth_settlement", attemptId: "someone-elses-attempt", service: "calendar", outcome: "succeeded" },
      })));
      expect(ack()).toBeNull();
    });
  });
});
