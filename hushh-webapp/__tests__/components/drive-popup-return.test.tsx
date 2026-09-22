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
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => {
    throw new Error("Drive popup must not use the opener Vault Owner token");
  },
}));
vi.mock("@/components/vault/vault-lock-guard", () => ({
  VaultLockGuard: () => {
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

describe("Drive popup completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth = {
      user: { uid: "owner-a", getIdToken: async () => "firebase-only" },
      loading: false,
    };
    mocks.complete.mockResolvedValue({
      connectorId: "google_drive",
      status: "verifying",
    });
    sessionStorage.setItem(
      "one_drive_popup_attempt_v1",
      JSON.stringify({
        connectorId: "google_drive",
        attemptId: "synthetic-attempt-id",
        expiresAt: Date.now() + 60_000,
      }),
    );
    window.history.replaceState(
      null,
      "",
      "/one/profile/connectors/oauth/return?code=secret-code&state=signed-state",
    );
    vi.spyOn(window, "close").mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    sessionStorage.clear();
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
      state: "signed-state",
      attemptId: "synthetic-attempt-id",
    });
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(window.location.search).toBe("");
    expect(document.body.textContent).not.toMatch(
      /secret-code|signed-state|firebase-only/,
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
    sessionStorage.setItem(
      "one_drive_popup_attempt_v1",
      JSON.stringify({
        connectorId: "google_drive",
        attemptId: "synthetic-attempt-id",
        expiresAt: 1,
      }),
    );
    render(<Callback />);
    await screen.findByText(/Authorization was not completed/);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
