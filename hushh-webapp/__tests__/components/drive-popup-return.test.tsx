import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
const mocks = vi.hoisted(() => ({
  auth: {
    user: null as null | { uid: string; getIdToken: () => Promise<string> },
    loading: false,
  },
  complete: vi.fn(),
  notify: vi.fn(),
  fullPageRendered: false,
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => {
    throw new Error("Drive popup must not use the opener Vault Owner token");
  },
}));
vi.mock("@/components/vault/vault-lock-guard", () => ({
  VaultLockGuard: () => {
    if (mocks.fullPageRendered) return <div>Full-page OAuth return</div>;
    throw new Error("Popup must not mount legacy vault guard");
  },
}));
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: { completeWebOAuth: mocks.complete },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/profile/drive-oauth-popup", async (original) => ({
  ...(await original<typeof import("@/lib/profile/drive-oauth-popup")>()),
  notifyDrivePopup: mocks.notify,
}));
import Callback from "@/app/one/profile/connectors/oauth/return/page";

const DRIVE_POPUP_ATTEMPT_KEY = "one_drive_popup_attempt_v1";
const SIGNED_STATE = `synthetic-attempt-id.${"a".repeat(64)}`;

describe("Drive popup completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fullPageRendered = false;
    if (typeof window.localStorage?.setItem !== "function") {
      const store = new Map<string, string>();
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
          get length() {
            return store.size;
          },
          clear: () => store.clear(),
          getItem: (key: string) => store.get(key) ?? null,
          key: (index: number) => Array.from(store.keys())[index] ?? null,
          removeItem: (key: string) => {
            store.delete(key);
          },
          setItem: (key: string, value: string) => {
            store.set(key, value);
          },
        },
      });
    }
    mocks.auth = {
      user: { uid: "owner-a", getIdToken: async () => "firebase-only" },
      loading: false,
    };
    mocks.complete.mockResolvedValue({
      connectorId: "google_drive",
      status: "verifying",
    });
    // Synthetic redacted attempt marker; no tokens or codes.
    window.localStorage.setItem(
      DRIVE_POPUP_ATTEMPT_KEY,
      JSON.stringify({
        connectorId: "google_drive",
        attemptId: "synthetic-attempt-id",
        expiresAt: Date.now() + 60_000,
      }),
    );
    window.history.replaceState(
      null,
      "",
      `/one/profile/connectors/oauth/return?code=secret-code&state=${SIGNED_STATE}`,
    );
    vi.spyOn(window, "close").mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // eslint-disable-next-line no-restricted-globals -- Clear the synthetic test marker between cases.
    sessionStorage.clear();
    window.localStorage.clear();
  });
  it("uses Firebase identity, scrubs URL, and settles once in Strict Mode", async () => {
    render(
      <StrictMode>
        <Callback />
      </StrictMode>,
    );
    await screen.findByText(/Authorization saved/);
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith({
      idToken: "firebase-only",
      code: "secret-code",
      state: SIGNED_STATE,
      attemptId: "synthetic-attempt-id",
    });
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(window.location.search).toBe("");
    expect(document.body.textContent).not.toMatch(
      /secret-code|synthetic-attempt-id|firebase-only/,
    );
  });
  it("cannot dispatch stale completion after sign-out during token resolution", async () => {
    let resolve!: (token: string) => void;
    mocks.auth.user!.getIdToken = () =>
      new Promise<string>((done) => {
        resolve = done;
      });
    const rendered = render(<Callback />);
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    mocks.auth.user = null;
    rendered.rerender(<Callback />);
    await act(async () => {
      resolve("stale-owner-token");
    });
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalledWith(
      expect.anything(),
      "succeeded",
    );
  });
  it("does not publish settlement after unmount", async () => {
    let resolve!: (result: unknown) => void;
    mocks.complete.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const rendered = render(<Callback />);
    await waitFor(() => expect(mocks.complete).toHaveBeenCalledOnce());
    rendered.unmount();
    await act(async () => {
      resolve({ connectorId: "google_drive", status: "verifying" });
    });
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("keeps an in-flight completion through benign same-owner auth refresh", async () => {
    let resolve!: (result: unknown) => void;
    mocks.complete.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(<Callback />);
    await waitFor(() => expect(mocks.complete).toHaveBeenCalledOnce());
    mocks.auth = {
      user: { uid: "owner-a", getIdToken: async () => "refreshed" },
      loading: true,
    };
    view.rerender(<Callback />);
    mocks.auth = { ...mocks.auth, loading: false };
    view.rerender(<Callback />);
    await act(async () => {
      resolve({ connectorId: "google_drive", status: "verifying" });
    });
    await screen.findByText(/Authorization saved/);
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledOnce();
  });
  it("never renders provider errors or treats expired attempts as success", async () => {
    // Synthetic expired attempt marker; no tokens or codes.
    window.localStorage.setItem(
      DRIVE_POPUP_ATTEMPT_KEY,
      JSON.stringify({
        connectorId: "google_drive",
        attemptId: "synthetic-attempt-id",
        expiresAt: 1,
      }),
    );
    mocks.fullPageRendered = true;
    render(<Callback />);
    await screen.findByText("Full-page OAuth return");
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("routes a different full-page attempt past a stale Drive popup marker", async () => {
    mocks.fullPageRendered = true;
    const otherAttemptId = "other-valid-attempt";
    window.sessionStorage.setItem(
      "one_drive_chat_recovery_handoff_v1",
      JSON.stringify({
        version: 1,
        ownerUserId: "owner-a",
        attemptId: otherAttemptId,
        reason: "web_full_page",
        expiresAt: Date.now() + 60_000,
        returnTo: "connector_settings",
      }),
    );
    window.history.replaceState(
      null,
      "",
      `/one/profile/connectors/oauth/return?code=secret-code&state=${otherAttemptId}.${"b".repeat(64)}`,
    );
    render(<Callback />);
    await screen.findByText("Full-page OAuth return");
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });
});
