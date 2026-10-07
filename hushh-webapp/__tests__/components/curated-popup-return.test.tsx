import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
const mocks = vi.hoisted(() => ({
  auth: {
    user: null as null | { uid: string; getIdToken: () => Promise<string> },
    loading: false,
  },
  complete: vi.fn(),
  completeLegacy: vi.fn(),
  notifyCurated: vi.fn(),
  notifyDrive: vi.fn(),
  fullPageRendered: false,
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => {
    throw new Error("A curated popup must not use the opener Vault Owner token");
  },
}));
vi.mock("@/components/vault/vault-lock-guard", () => ({
  VaultLockGuard: () => {
    if (mocks.fullPageRendered) return <div>Full-page OAuth return</div>;
    throw new Error("Popup must not mount the vault guard");
  },
}));
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: {
    completeWebOAuth: mocks.complete,
    completeOAuthConnect: mocks.completeLegacy,
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/profile/curated-connector-popup", async (original) => ({
  ...(await original<typeof import("@/lib/profile/curated-connector-popup")>()),
  notifyCuratedPopup: mocks.notifyCurated,
}));
vi.mock("@/lib/profile/drive-oauth-popup", async (original) => ({
  ...(await original<typeof import("@/lib/profile/drive-oauth-popup")>()),
  notifyDrivePopup: mocks.notifyDrive,
}));
import Callback from "@/app/one/profile/connectors/oauth/return/page";

const CURATED_KEY = "one_curated_popup_attempt_v1";
const DRIVE_KEY = "one_drive_popup_attempt_v1";
const ATTEMPT_ID = "synthetic-attempt-id";
const SIGNED_STATE = `${ATTEMPT_ID}.${"a".repeat(64)}`;
const returnUrl = (query: string) => `/one/profile/connectors/oauth/return?${query}`;

describe("curated connector popup completion", () => {
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
    window.localStorage.clear();
    mocks.auth = {
      user: { uid: "owner-a", getIdToken: async () => "firebase-only" },
      loading: false,
    };
    mocks.complete.mockResolvedValue({ connectorId: "notion", status: "verifying" });
    // Synthetic redacted attempt marker; no tokens or codes.
    window.localStorage.setItem(
      CURATED_KEY,
      JSON.stringify({ connectorId: "notion", attemptId: ATTEMPT_ID, expiresAt: Date.now() + 60_000 }),
    );
    window.history.replaceState(null, "", returnUrl(`code=secret-code&state=${SIGNED_STATE}`));
    vi.spyOn(window, "close").mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // eslint-disable-next-line no-restricted-globals -- Clear the synthetic test marker between cases.
    sessionStorage.clear();
    window.localStorage.clear();
  });

  it("completes with the Firebase identity only, notifies the opener and closes", async () => {
    render(
      <StrictMode>
        <Callback />
      </StrictMode>,
    );
    await screen.findByText(/Connection saved/);
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith({
      idToken: "firebase-only",
      code: "secret-code",
      state: SIGNED_STATE,
      attemptId: ATTEMPT_ID,
    });
    expect(mocks.completeLegacy).not.toHaveBeenCalled();
    expect(mocks.notifyCurated).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ connectorId: "notion", attemptId: ATTEMPT_ID }),
      "succeeded",
    );
    expect(mocks.notifyDrive).not.toHaveBeenCalled();
    expect(window.close).toHaveBeenCalled();
    expect(window.location.search).toBe("");
    expect(document.body.textContent).not.toMatch(/secret-code|synthetic-attempt-id|firebase-only/);
  });
  it("accepts a connected result", async () => {
    mocks.complete.mockResolvedValue({ connectorId: "notion", status: "connected" });
    render(<Callback />);
    await screen.findByText(/Connection saved/);
    expect(mocks.notifyCurated).toHaveBeenCalledWith(expect.anything(), "succeeded");
  });
  it.each([
    ["a different connector", { connectorId: "hubspot", status: "connected" }],
    ["a disconnected status", { connectorId: "notion", status: "needs_reauth" }],
  ])("reports failure for %s", async (_label, result) => {
    mocks.complete.mockResolvedValue(result);
    render(<Callback />);
    await screen.findByText(/not completed/);
    expect(mocks.notifyCurated).toHaveBeenCalledExactlyOnceWith(expect.anything(), "failed");
    expect(window.close).toHaveBeenCalled();
  });
  it("reports failure when the exchange is rejected, without rendering the error", async () => {
    mocks.complete.mockRejectedValue(new Error("secret-code rejected by provider"));
    render(<Callback />);
    await screen.findByText(/not completed/);
    expect(mocks.notifyCurated).toHaveBeenCalledExactlyOnceWith(expect.anything(), "failed");
    expect(document.body.textContent).not.toMatch(/secret-code/);
  });
  it("reports a cancelled provider return without exchanging anything", async () => {
    window.history.replaceState(null, "", returnUrl(`error=access_denied&state=${SIGNED_STATE}`));
    render(<Callback />);
    await screen.findByText(/not completed/);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.notifyCurated).toHaveBeenCalledExactlyOnceWith(expect.anything(), "cancelled");
    expect(window.close).toHaveBeenCalled();
  });
  it("fails without a Firebase user and never dispatches", async () => {
    mocks.auth = { user: null, loading: false };
    render(<Callback />);
    await screen.findByText(/not completed/);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.notifyCurated).toHaveBeenCalledExactlyOnceWith(expect.anything(), "failed");
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
    expect(mocks.notifyCurated).not.toHaveBeenCalledWith(expect.anything(), "succeeded");
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
      resolve({ connectorId: "notion", status: "verifying" });
    });
    expect(mocks.notifyCurated).not.toHaveBeenCalled();
  });
  it("waits for auth to load before completing", async () => {
    mocks.auth = { ...mocks.auth, loading: true };
    const view = render(<Callback />);
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(mocks.complete).not.toHaveBeenCalled();
    mocks.auth = { ...mocks.auth, loading: false };
    view.rerender(<Callback />);
    await screen.findByText(/Connection saved/);
    expect(mocks.complete).toHaveBeenCalledOnce();
  });
  it("still routes a Drive popup return to the Drive branch", async () => {
    window.localStorage.clear();
    window.localStorage.setItem(
      DRIVE_KEY,
      JSON.stringify({ connectorId: "google_drive", attemptId: ATTEMPT_ID, expiresAt: Date.now() + 60_000 }),
    );
    mocks.complete.mockResolvedValue({ connectorId: "google_drive", status: "verifying" });
    render(<Callback />);
    await screen.findByText(/Authorization saved/);
    expect(mocks.notifyDrive).toHaveBeenCalledExactlyOnceWith(expect.anything(), "succeeded");
    expect(mocks.notifyCurated).not.toHaveBeenCalled();
  });
  it("sends a curated sign-in with no popup marker to the full-page return", async () => {
    window.localStorage.clear();
    mocks.fullPageRendered = true;
    render(<Callback />);
    await screen.findByText("Full-page OAuth return");
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.notifyCurated).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });
  it("routes a different full-page attempt past a stale curated popup marker", async () => {
    mocks.fullPageRendered = true;
    window.history.replaceState(
      null,
      "",
      returnUrl(`code=secret-code&state=other-valid-attempt.${"b".repeat(64)}`),
    );
    render(<Callback />);
    await screen.findByText("Full-page OAuth return");
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.notifyCurated).not.toHaveBeenCalled();
  });
});
