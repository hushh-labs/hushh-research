import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  CapacitorHttp: { request: vi.fn() },
}));
vi.mock("@/lib/capacitor", () => ({
  HushhVault: {},
  HushhAuth: {},
  HushhConsent: {},
  HushhNotifications: {},
}));
vi.mock("@/lib/capacitor/kai", () => ({
  Kai: { addListener: vi.fn() },
  PORTFOLIO_STREAM_EVENT: "portfolio_stream",
  KAI_STREAM_EVENT: "kai_stream",
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdToken: vi.fn(), getCurrentUser: vi.fn() },
}));
vi.mock("@/lib/observability/client", () => ({
  toDurationBucket: () => "fast",
  trackApiRequestCompleted: vi.fn(),
  trackEvent: vi.fn(),
}));
vi.mock("@/lib/observability/route-map", () => ({ resolveRouteId: () => "test-route" }));
vi.mock("@/lib/motion/api-progress-tracker", () => ({
  trackRequestStart: vi.fn(),
  trackRequestEnd: vi.fn(),
}));

import { ApiService } from "@/lib/services/api-service";
import { AuthService } from "@/lib/services/auth-service";
import {
  AzureByocError,
  isUsableAzureSubscription,
  parseAzureAuthorizationStart,
  parseAzureAuthorizeCompletion,
} from "@/lib/services/azure-byoc-contract";

const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
const SIGN_IN = "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=c&state=s";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lastRequest(): { url: string; init: RequestInit; body: unknown } {
  const [url, init] = mockFetch.mock.calls.at(-1) as [string, RequestInit];
  return { url: String(url), init, body: JSON.parse(String(init.body)) };
}

async function refusal(promise: Promise<unknown>): Promise<AzureByocError> {
  const error = await promise.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(AzureByocError);
  return error as AzureByocError;
}

describe("ApiService Connect Azure methods", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(AuthService.getIdToken).mockResolvedValue("firebase-id-token");
  });

  it("begins the setup sign-in with Firebase auth and no subscription by default", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ authorizationUrl: SIGN_IN }));
    await expect(ApiService.beginAzureByocAuthorize()).resolves.toEqual({ authorizationUrl: SIGN_IN });
    const sent = lastRequest();
    expect(sent.url).toContain("/api/one/runtime/byoc/azure/authorize/begin");
    expect(sent.init.method).toBe("POST");
    expect(new Headers(sent.init.headers).get("Authorization")).toBe("Bearer firebase-id-token");
    expect(sent.body).toEqual({});
  });

  it("scopes the setup sign-in to a chosen subscription", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ authorizationUrl: SIGN_IN }));
    await ApiService.beginAzureByocAuthorize({ subscriptionId: "sub-1" });
    expect(lastRequest().body).toEqual({ subscriptionId: "sub-1" });
  });

  it("exchanges the Microsoft code and state once and returns the typed outcome", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: "setup_started", jobId: "job-1" }));
    await expect(ApiService.completeAzureByocAuthorize({ code: "c0de", state: "st4te" })).resolves.toEqual({
      status: "setup_started",
      jobId: "job-1",
    });
    const sent = lastRequest();
    expect(sent.url).toContain("/api/one/runtime/byoc/azure/authorize/complete");
    expect(sent.body).toEqual({ code: "c0de", state: "st4te" });
  });

  it("begins an update sign-in with an empty body", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ authorizationUrl: SIGN_IN }));
    await expect(ApiService.beginAzureByocUpgrade()).resolves.toEqual({ authorizationUrl: SIGN_IN });
    const sent = lastRequest();
    expect(sent.url).toContain("/api/one/runtime/byoc/azure/upgrade/begin");
    expect(sent.body).toEqual({});
  });

  it("keeps the hub's typed reason and drops untyped error bodies", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ detail: { code: "POD_ASSIGNMENT_PRESERVED", message: "Your agent already has a home." } }, 409),
    );
    const typed = await refusal(ApiService.beginAzureByocAuthorize());
    expect(typed.code).toBe("AZURE_AUTHORIZE_BEGIN_FAILED");
    expect(typed.httpStatus).toBe(409);
    expect(typed.serverCode).toBe("POD_ASSIGNMENT_PRESERVED");
    expect(typed.serverMessage).toBe("Your agent already has a home.");

    mockFetch.mockResolvedValueOnce(jsonResponse({ detail: "AADSTS70021: raw upstream text" }, 502));
    const untyped = await refusal(ApiService.completeAzureByocAuthorize({ code: "c", state: "s" }));
    expect(untyped.code).toBe("AZURE_AUTHORIZE_COMPLETE_FAILED");
    expect(untyped.serverMessage).toBeNull();

    mockFetch.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));
    const unreadable = await refusal(ApiService.beginAzureByocUpgrade());
    expect(unreadable.code).toBe("AZURE_UPGRADE_BEGIN_FAILED");
    expect(unreadable.serverCode).toBeNull();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ detail: { code: "X", message: "x".repeat(241) } }, 400),
    );
    expect((await refusal(ApiService.beginAzureByocAuthorize())).serverMessage).toBeNull();
  });

  it("never navigates to an address that is not a Microsoft sign-in page", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ authorizationUrl: "https://evil.example/authorize" }));
    expect((await refusal(ApiService.beginAzureByocAuthorize())).code).toBe("AZURE_RESPONSE_INVALID");
  });
});

describe("Connect Azure contract parsing", () => {
  it.each([
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    "https://login.microsoft.com/tenant/oauth2/v2.0/authorize",
    "https://login.microsoftonline.us/tenant/oauth2/v2.0/authorize",
  ])("accepts the Microsoft sign-in host in %s", (url) => {
    expect(parseAzureAuthorizationStart({ authorizationUrl: url }).authorizationUrl).toBe(url);
  });

  it.each([
    null,
    {},
    { authorizationUrl: 42 },
    { authorizationUrl: "not a url" },
    { authorizationUrl: "http://login.microsoftonline.com/x" },
    { authorizationUrl: "https://login.microsoftonline.com.evil.example/x" },
    { authorizationUrl: "https://user:pw@login.microsoftonline.com/x" },
    { authorizationUrl: "https://login.microsoftonline.com:8443/x" },
    { authorizationUrl: "https://login.microsoftonline.com/x#fragment" },
    { authorizationUrl: `https://login.microsoftonline.com/${"a".repeat(16_001)}` },
  ])("refuses the begin payload %j", (payload) => {
    expect(() => parseAzureAuthorizationStart(payload)).toThrow(AzureByocError);
  });

  it("reads each completion outcome", () => {
    expect(parseAzureAuthorizeCompletion({ status: "upgrade_started", jobId: "j" })).toEqual({
      status: "upgrade_started",
      jobId: "j",
    });
    expect(
      parseAzureAuthorizeCompletion({
        status: "needs_subscription",
        subscriptions: [
          { subscriptionId: "a", displayName: "Pay-As-You-Go", state: "Enabled" },
          { subscriptionId: "", displayName: "blank id", state: "Enabled" },
          { subscriptionId: "b", displayName: 7, state: "Enabled" },
          "junk",
        ],
      }),
    ).toEqual({
      status: "needs_subscription",
      subscriptions: [{ subscriptionId: "a", displayName: "Pay-As-You-Go", state: "Enabled" }],
    });
  });

  it("reads a continue outcome only when it points at a Microsoft sign-in page", () => {
    const next = "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=s2";
    expect(parseAzureAuthorizeCompletion({ status: "continue", authorizationUrl: next })).toEqual({
      status: "continue",
      authorizationUrl: next,
    });
  });

  it.each([
    null,
    { status: "setup_started" },
    { status: "setup_started", jobId: " " },
    { status: "needs_subscription" },
    { status: "done", jobId: "j" },
    { status: "continue" },
    { status: "continue", authorizationUrl: "https://evil.example/authorize" },
    { status: "continue", authorizationUrl: "http://login.microsoftonline.com/x" },
  ])("refuses the completion payload %j", (payload) => {
    expect(() => parseAzureAuthorizeCompletion(payload)).toThrow(AzureByocError);
  });

  it("treats only an enabled subscription as usable", () => {
    const base = { subscriptionId: "a", displayName: "A" };
    expect(isUsableAzureSubscription({ ...base, state: "Enabled" })).toBe(true);
    expect(isUsableAzureSubscription({ ...base, state: "enabled" })).toBe(true);
    for (const state of ["Disabled", "PastDue", "Warned", "Deleted", ""]) {
      expect(isUsableAzureSubscription({ ...base, state })).toBe(false);
    }
  });
});
