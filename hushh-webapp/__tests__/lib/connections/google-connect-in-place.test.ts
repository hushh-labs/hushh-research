import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  native: false,
  gmailStartConnect: vi.fn(),
  gmailGetStatus: vi.fn(),
  gmailStartNative: vi.fn(),
  gmailCompleteNative: vi.fn(),
  recordConsentFailure: vi.fn(),
  calendarStartConnect: vi.fn(),
  calendarStatus: vi.fn(),
  calendarStartNative: vi.fn(),
  calendarCompleteNative: vi.fn(),
  connectGmail: vi.fn(),
  connectCalendar: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => mocks.native },
}));
vi.mock("@/lib/capacitor", () => ({
  HushhAuth: { connectGmail: mocks.connectGmail, connectCalendar: mocks.connectCalendar },
}));
vi.mock("@/lib/services/gmail-receipts-service", () => ({
  GmailReceiptsService: {
    startConnect: mocks.gmailStartConnect,
    getStatus: mocks.gmailGetStatus,
    startNativeConnect: mocks.gmailStartNative,
    completeNativeConnect: mocks.gmailCompleteNative,
    recordConsentFailure: mocks.recordConsentFailure,
  },
}));
vi.mock("@/lib/services/google-calendar-service", () => ({
  GoogleCalendarService: {
    startConnect: mocks.calendarStartConnect,
    status: mocks.calendarStatus,
    startNativeConnect: mocks.calendarStartNative,
    completeNativeConnect: mocks.calendarCompleteNative,
  },
}));

import {
  connectCalendarInPlace,
  connectGmailInPlace,
} from "@/lib/connections/google-connect-in-place";

const GMAIL_ATTEMPT_KEY = "one_gmail_oauth_popup_attempt_v1";
const GOOGLE_ATTEMPT_KEY = "one_google_oauth_popup_attempt_v1";
const GMAIL_SETTLEMENT_KEY = "one_gmail_oauth_popup_settlement_v1";
const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth?synthetic=1";

type FakeWindow = Window & {
  close: ReturnType<typeof vi.fn>;
  location: { replace: ReturnType<typeof vi.fn> };
};
function fakeWindow(): FakeWindow {
  const store = new Map<string, string>();
  const storage = {
    setItem: (key: string, value: string) => void store.set(key, value),
    getItem: (key: string) => store.get(key) ?? null,
    removeItem: (key: string) => void store.delete(key),
  };
  return {
    close: vi.fn(),
    focus: vi.fn(),
    document: { title: "", body: { textContent: "", style: { cssText: "" } } },
    location: { replace: vi.fn() },
    sessionStorage: storage,
    localStorage: storage,
  } as unknown as FakeWindow;
}
const owner = {
  uid: "owner-a",
  getIdToken: vi.fn(async () => "synthetic-firebase-token"),
  email: "owner@synthetic.invalid",
  providerData: [{ providerId: "google.com" }],
};
const attemptIn = (target: Window, key: string) =>
  JSON.parse(target.sessionStorage.getItem(key) || "null") as { attemptId: string };
const post = (data: unknown, source: unknown, origin = window.location.origin) =>
  window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
const gmailSettlement = (attemptId: string, outcome = "succeeded") => ({
  schemaVersion: 1,
  type: "gmail_oauth_settlement",
  attemptId,
  outcome,
});
const calendarSettlement = (attemptId: string, outcome = "succeeded") => ({
  schemaVersion: 1,
  type: "google_oauth_settlement",
  attemptId,
  service: "calendar",
  outcome,
});
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe("connectGmailInPlace (web)", () => {
  let popup: FakeWindow;
  beforeEach(() => {
    mocks.native = false;
    popup = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(popup);
    mocks.gmailStartConnect.mockReset().mockResolvedValue({
      configured: true,
      authorize_url: AUTHORIZE,
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    mocks.gmailGetStatus.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("opens the window synchronously, before any await, and never navigates this window", () => {
    const before = window.location.href;
    const start = connectGmailInPlace({ owner, purpose: "send" });
    // window.open ran inside the call itself: the click keeps its gesture.
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(start.surface).toBe("window");
    expect(mocks.gmailStartConnect).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
    void start.result;
  });

  it("settles only the exact attempt from the exact window and origin, then trusts server status", async () => {
    mocks.gmailGetStatus.mockResolvedValue({ connected: true, send_permission_granted: true });
    const start = connectGmailInPlace({ owner, purpose: "send" });
    await vi.waitFor(() => expect(popup.location.replace).toHaveBeenCalledWith(AUTHORIZE));
    expect(mocks.gmailStartConnect).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "send", includeGrantedScopes: true, loginHint: "owner@synthetic.invalid" }),
    );
    const { attemptId } = attemptIn(popup, GMAIL_ATTEMPT_KEY);
    const done = vi.fn();
    void start.result.then(done);
    // Negative controls.
    post(gmailSettlement(attemptId), popup, "https://attacker.invalid");
    post(gmailSettlement(attemptId), window);
    post(gmailSettlement("another-valid-attempt"), popup);
    post({ ...gmailSettlement(attemptId), type: "google_oauth_settlement" }, popup);
    await flush();
    expect(done).not.toHaveBeenCalled();
    expect(mocks.gmailGetStatus).not.toHaveBeenCalled();
    post(gmailSettlement(attemptId), popup);
    await expect(start.result).resolves.toBe("connected");
    expect(mocks.gmailGetStatus).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(popup.close).toHaveBeenCalled();
  });

  it("does not claim sending when the callback says success but the grant is missing", async () => {
    mocks.gmailGetStatus.mockResolvedValue({ connected: true, send_permission_granted: false });
    const start = connectGmailInPlace({ owner, purpose: "send" });
    await vi.waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
    post(gmailSettlement(attemptIn(popup, GMAIL_ATTEMPT_KEY).attemptId), popup);
    await expect(start.result).resolves.toBe("not_connected");
  });

  it("verifies the modify grant for mailbox changes and settles through storage when the opener is severed", async () => {
    mocks.gmailGetStatus.mockResolvedValue({ connected: true, modify_permission_granted: true });
    const start = connectGmailInPlace({ owner, purpose: "modify" });
    await vi.waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
    expect(mocks.gmailStartConnect).toHaveBeenCalledWith(expect.objectContaining({ purpose: "modify" }));
    const { attemptId } = attemptIn(popup, GMAIL_ATTEMPT_KEY);
    window.dispatchEvent(new StorageEvent("storage", {
      key: GMAIL_SETTLEMENT_KEY,
      newValue: JSON.stringify({ ...gmailSettlement(attemptId), sentAt: Date.now() }),
      storageArea: window.localStorage,
    }));
    await expect(start.result).resolves.toBe("connected");
  });

  it("cancel ends quietly as not connected, and a late callback changes nothing", async () => {
    const cancel = new AbortController();
    const start = connectGmailInPlace({ owner, purpose: "send", cancelSignal: cancel.signal });
    await vi.waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
    const { attemptId } = attemptIn(popup, GMAIL_ATTEMPT_KEY);
    cancel.abort();
    await expect(start.result).resolves.toBe("not_connected");
    post(gmailSettlement(attemptId), popup);
    await flush();
    expect(mocks.gmailGetStatus).not.toHaveBeenCalled();
  });

  it("is stale, not connected, when the owner changes while the window is open", async () => {
    let current = true;
    mocks.gmailGetStatus.mockResolvedValue({ connected: true, send_permission_granted: true });
    const start = connectGmailInPlace({ owner, purpose: "send", isCurrent: () => current });
    await vi.waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
    current = false;
    post(gmailSettlement(attemptIn(popup, GMAIL_ATTEMPT_KEY).attemptId), popup);
    await expect(start.result).resolves.toBe("stale");
  });

  it("refuses a non-Google authorize URL without navigating the window", async () => {
    mocks.gmailStartConnect.mockResolvedValue({
      configured: true,
      authorize_url: "https://attacker.invalid/o/oauth2/v2/auth",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const start = connectGmailInPlace({ owner, purpose: "send" });
    await expect(start.result).resolves.toBe("failed");
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalled();
  });

  it("reports blocked, without any request, when popup and tab are both refused", async () => {
    vi.mocked(window.open).mockReturnValue(null);
    const before = window.location.href;
    const start = connectGmailInPlace({ owner, purpose: "send" });
    expect(start.surface).toBe("blocked");
    await expect(start.result).resolves.toBe("not_connected");
    expect(window.open).toHaveBeenCalledTimes(2);
    expect(mocks.gmailStartConnect).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
  });
});

describe("connectGmailInPlace (native)", () => {
  beforeEach(() => {
    mocks.native = true;
    vi.spyOn(window, "open");
    mocks.gmailGetStatus.mockReset().mockResolvedValue({ connected: true, modify_permission_granted: true });
    mocks.gmailStartNative.mockReset().mockResolvedValue({ configured: true, server_client_id: "native-client", purpose: "send" });
    mocks.connectGmail.mockReset();
    mocks.gmailCompleteNative.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("grants sending through the platform sheet, preserving modify, without a window", async () => {
    mocks.connectGmail.mockResolvedValue({ serverAuthCode: "synthetic-auth-code" });
    mocks.gmailCompleteNative.mockResolvedValue({ connected: true, send_permission_granted: true });
    const start = connectGmailInPlace({ owner, purpose: "send" });
    expect(start.surface).toBe("native");
    await expect(start.result).resolves.toBe("connected");
    expect(mocks.connectGmail).toHaveBeenCalledWith({ serverClientId: "native-client", purpose: "send", preserveModify: true });
    expect(window.open).not.toHaveBeenCalled();
  });

  it("treats a dismissed sheet as quietly not connected", async () => {
    mocks.connectGmail.mockRejectedValue(Object.assign(new Error("cancelled"), { code: "USER_CANCELLED" }));
    const start = connectGmailInPlace({ owner, purpose: "send" });
    await expect(start.result).resolves.toBe("not_connected");
    expect(mocks.gmailCompleteNative).not.toHaveBeenCalled();
  });

  it("does not start a modify grant the native plugins would reject", async () => {
    const start = connectGmailInPlace({ owner, purpose: "modify" });
    expect(start.surface).toBe("unsupported");
    await expect(start.result).resolves.toBe("not_connected");
    expect(mocks.gmailStartNative).not.toHaveBeenCalled();
  });
});

describe("connectCalendarInPlace", () => {
  let popup: FakeWindow;
  beforeEach(() => {
    mocks.native = false;
    popup = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(popup);
    mocks.calendarStartConnect.mockReset().mockResolvedValue({
      authorize_url: AUTHORIZE,
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    mocks.calendarStatus.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("requires manage access for a scheduling connect", async () => {
    mocks.calendarStatus.mockResolvedValue({ connected: true, status: "connected", access_level: "read" });
    const start = connectCalendarInPlace({ owner, accessLevel: "manage" });
    await vi.waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
    const { attemptId } = attemptIn(popup, GOOGLE_ATTEMPT_KEY);
    post({ ...calendarSettlement(attemptId), service: "gmail_send" }, popup);
    await flush();
    expect(mocks.calendarStatus).not.toHaveBeenCalled();
    post(calendarSettlement(attemptId), popup);
    await expect(start.result).resolves.toBe("not_connected");
  });

  it("connects natively through the platform sheet", async () => {
    mocks.native = true;
    mocks.calendarStartNative.mockResolvedValue({ server_client_id: "native-client", access_level: "manage", state: "signed-state" });
    mocks.connectCalendar.mockResolvedValue({ serverAuthCode: "synthetic-auth-code" });
    mocks.calendarCompleteNative.mockResolvedValue({ connected: true, status: "connected", access_level: "manage" });
    const start = connectCalendarInPlace({ owner, accessLevel: "manage" });
    expect(start.surface).toBe("native");
    await expect(start.result).resolves.toBe("connected");
    expect(window.open).not.toHaveBeenCalled();
    expect(mocks.calendarCompleteNative).toHaveBeenCalledWith(
      expect.objectContaining({ accessLevel: "manage", state: "signed-state" }),
    );
  });
});
