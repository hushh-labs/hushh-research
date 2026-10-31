import { vi } from "vitest";
const googlePlacement = vi.hoisted(() => vi.fn(async () => false));
vi.mock('@/lib/services/private-agent-specialist-chat', () => ({ ownerContentIsPrivate: googlePlacement }));


const capacitorMocks = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  getPlatform: vi.fn(() => "web"),
  request: vi.fn(),
  registerNativePush: vi.fn(),
}));

const nativeStreamFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/native-sse-fetch", () => ({ nativeStreamFetch }));

const previewMocks = vi.hoisted(() => ({ prepare: vi.fn(), keyId: "fixture-key" }));
vi.mock("@/lib/notifications/preview-keys", () => ({
  prepareNotificationDevice: previewMocks.prepare,
  activeNotificationKeyId: () => previewMocks.keyId,
  notificationDeviceId: async () => "388b1e4b-25cf-4c63-aed0-281607f3dd9b",
}));

const kaiMocks = vi.hoisted(() => ({
  addListener: vi.fn(),
  streamPortfolioImport: vi.fn(),
  streamPortfolioImportRun: vi.fn(),
  streamPortfolioAnalyzeLosers: vi.fn(),
  streamKaiAnalysis: vi.fn(),
  cancelKaiAnalysisStream: vi.fn(),
}));

const requestTimeoutMocks = vi.hoisted(() => ({
  resolveSlowRequestTimeoutMs: vi.fn(() => 75_000),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: capacitorMocks.isNativePlatform,
    getPlatform: capacitorMocks.getPlatform,
  },
  CapacitorHttp: { request: capacitorMocks.request },
}));

vi.mock("@/lib/capacitor", () => ({
  HushhVault: {},
  HushhAuth: {},
  HushhConsent: {},
  HushhNotifications: { registerPushToken: capacitorMocks.registerNativePush },
}));

vi.mock("@/lib/capacitor/kai", () => ({
  Kai: kaiMocks,
  PORTFOLIO_STREAM_EVENT: "portfolio_stream",
  KAI_STREAM_EVENT: "kai_stream",
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    getIdToken: vi.fn(),
    getCurrentUser: vi.fn(),
    isUatPhoneTestVerificationId: (id?: string) => String(id ?? "").startsWith("uat-test-phone:"),
  },
}));

vi.mock("@/lib/observability/client", () => ({
  toDurationBucket: () => "fast",
  trackApiRequestCompleted: vi.fn(),
  trackEvent: vi.fn(),
}));

vi.mock("@/lib/observability/route-map", () => ({
  resolveRouteId: () => "test-route",
}));

vi.mock("@/lib/motion/api-progress-tracker", () => ({
  trackRequestStart: vi.fn(),
  trackRequestEnd: vi.fn(),
}));

vi.mock("@/lib/utils/request-timeouts", () => ({
  resolveSlowRequestTimeoutMs: requestTimeoutMocks.resolveSlowRequestTimeoutMs,
}));


export { googlePlacement, capacitorMocks, nativeStreamFetch, previewMocks, kaiMocks, requestTimeoutMocks };
