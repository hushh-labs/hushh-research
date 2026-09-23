import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  native: false,
  connectDrive: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: mocks.apiFetch },
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => mocks.native,
    getPlatform: () => (mocks.native ? "ios" : "web"),
  },
}));
vi.mock("@/lib/capacitor", () => ({
  HushhAuth: { connectDrive: mocks.connectDrive },
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: { promise: mocks.toast },
}));
import { DriveConnectorCard } from "@/components/agent/drive-connector-card";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { CacheService } from "@/lib/services/cache-service";

const disconnected = {
  configured: true,
  connected: false,
  status: "disconnected",
  access_level: null,
};
const connected = {
  ...disconnected,
  connected: true,
  status: "connected",
  access_level: "read",
};
const response = (body: unknown) => ({ ok: true, json: async () => body });
const user = {
  uid: "owner-a",
  getIdToken: vi.fn(async () => "synthetic-token"),
};
function mount() {
  return render(<DriveConnectorCard user={user} enabled onUnlock={vi.fn()} />);
}
async function clickConnect() {
  const button = await screen.findByRole("button", { name: "Connect Drive" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}
function popup() {
  const data = new Map<string, string>();
  const result = {
    closed: false,
    close: vi.fn(),
    focus: vi.fn(),
    document: { title: "" },
    location: { replace: vi.fn() },
    sessionStorage: {
      setItem: (key: string, value: string) => data.set(key, value),
      getItem: (key: string) => data.get(key),
    },
  } as unknown as Window;
  vi.spyOn(window, "open").mockReturnValue(result);
  return {
    window: result,
    succeed: () => {
      const attempt = JSON.parse(
        data.get("one_google_oauth_popup_attempt_v1")!,
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: result,
          data: {
            schemaVersion: 1,
            type: "google_oauth_settlement",
            attemptId: attempt.attemptId,
            service: "drive",
            outcome: "succeeded",
          },
        }),
      );
    },
  };
}
describe("Drive connection controls", () => {
  it("automatically loads a fresh status when reopened during an obsolete read", async () => {
    let finish!: (value: unknown) => void;
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const first = mount();
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledOnce());
    first.unmount();
    mount();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Connect Drive" }),
      ).toBeEnabled(),
    );
    await act(async () => finish(connected));
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
  });
  it("distinguishes failed status from a disconnected account without exposing the error", async () => {
    mocks.apiFetch.mockRejectedValue(new Error("PRIVATE PROVIDER BODY"));
    mount();
    await screen.findByText("We couldn’t check Drive. Try Refresh.");
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    expect(screen.queryByText(/PRIVATE/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect Drive" }),
    ).toBeDisabled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.native = false;
    mocks.apiFetch.mockReset().mockResolvedValue(response(disconnected));
    user.getIdToken.mockReset().mockResolvedValue("synthetic-token");
    publishValidatedAuthSessionOwner(null);
    publishValidatedAuthSessionOwner(user.uid);
    CacheService.getInstance().clear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it("never claims connected when popup acknowledgement is followed by disconnected authority", async () => {
    const browser = popup();
    mocks.apiFetch.mockImplementation(async (path: string) =>
      response(
        path.endsWith("connect/start")
          ? { authorize_url: "https://accounts.google.com/o/oauth2/v2/auth" }
          : disconnected,
      ),
    );
    mount();
    await clickConnect();
    await waitFor(() =>
      expect(browser.window.location.replace).toHaveBeenCalledOnce(),
    );
    const pending: Promise<void> = mocks.toast.mock.calls[0][0];
    await act(async () => {
      browser.succeed();
      await expect(pending).rejects.toThrow("not connected");
    });
  });
  it("opens synchronously, then prevents initiation after observed popup closure during token wait", async () => {
    const browser = popup();
    mount();
    const button = await screen.findByRole("button", { name: "Connect Drive" });
    await waitFor(() => expect(button).toBeEnabled());
    let finish!: (token: string) => void;
    user.getIdToken.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.useFakeTimers();
    fireEvent.click(button);
    expect(window.open).toHaveBeenCalledOnce();
    Object.assign(browser.window, { closed: true });
    await act(async () => {
      vi.advanceTimersByTime(500);
      finish("synthetic-token");
    });
    expect(
      mocks.apiFetch.mock.calls.every(
        ([path]) => !path.endsWith("connect/start"),
      ),
    ).toBe(true);
    expect(browser.window.location.replace).not.toHaveBeenCalled();
  });
  it("does not expose raw native errors", async () => {
    mocks.native = true;
    mocks.connectDrive.mockRejectedValue(new Error("PRIVATE PROVIDER BODY"));
    mocks.apiFetch.mockImplementation(async (path: string) =>
      response(
        path.endsWith("native/start")
          ? {
              service: "drive",
              access_level: "read",
              state: "synthetic-state",
              server_client_id: "synthetic-client",
            }
          : disconnected,
      ),
    );
    mount();
    await clickConnect();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledOnce());
    const [pending, options] = mocks.toast.mock.calls[0];
    await act(async () => {
      const error = await pending.catch((value: unknown) => value);
      expect(options.error(error)).not.toContain("PRIVATE");
    });
  });
  it("preserves exact native state and refuses a late SDK completion after unmount", async () => {
    mocks.native = true;
    let finish!: (value: { serverAuthCode: string }) => void;
    mocks.connectDrive.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mocks.apiFetch.mockImplementation(async (path: string) =>
      response(
        path.endsWith("native/start")
          ? {
              service: "drive",
              access_level: "read",
              state: "synthetic-state",
              server_client_id: "synthetic-client",
            }
          : disconnected,
      ),
    );
    const view = mount();
    await clickConnect();
    await waitFor(() => expect(mocks.connectDrive).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => finish({ serverAuthCode: "synthetic-code" }));
    expect(
      mocks.apiFetch.mock.calls.every(
        ([path]) => !path.endsWith("native/complete"),
      ),
    ).toBe(true);
  });
  it("requires confirmation before disconnecting", async () => {
    mocks.apiFetch.mockImplementation(async (path: string) =>
      response(path.endsWith("disconnect") ? disconnected : connected),
    );
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Disconnect Drive" }),
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(
      mocks.apiFetch.mock.calls.every(([path]) => !path.endsWith("disconnect")),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Disconnect", exact: true }),
    );
    await waitFor(() =>
      expect(
        mocks.apiFetch.mock.calls.some(([path]) => path.endsWith("disconnect")),
      ).toBe(true),
    );
  });
});
