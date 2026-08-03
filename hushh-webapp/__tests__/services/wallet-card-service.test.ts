import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  MockApiError,
  mockApiErrorCode,
  mockApiJson,
  mockApiFetch,
  mockGetDirectBackendUrl,
  mockResolveRuntimeFrontendUrl,
  mockIsNative,
  mockIsIOS,
  mockOpenExternalUrl,
} = vi.hoisted(() => {
  class HoistedApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly payload?: unknown,
    ) {
      super(message);
      this.name = "ApiError";
    }
  }

  /** Mirrors api-client.ts: the code may sit under `detail` or `error`. */
  const nestedCode = (payload: unknown): string | null => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.code === "string" && record.code.trim()) {
      return record.code.trim();
    }
    return nestedCode(record.detail) ?? nestedCode(record.error);
  };

  return {
    MockApiError: HoistedApiError,
    mockApiErrorCode: (error: unknown) =>
      error instanceof HoistedApiError ? nestedCode(error.payload) : null,
    mockApiJson: vi.fn(),
    mockApiFetch: vi.fn(),
    mockGetDirectBackendUrl: vi.fn(),
    mockResolveRuntimeFrontendUrl: vi.fn(),
    mockIsNative: vi.fn(),
    mockIsIOS: vi.fn(),
    mockOpenExternalUrl: vi.fn(),
  };
});

vi.mock("@/lib/services/api-client", () => ({
  ApiError: MockApiError,
  apiErrorCode: mockApiErrorCode,
  apiJson: mockApiJson,
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: mockApiFetch,
    getDirectBackendUrl: mockGetDirectBackendUrl,
  },
}));

vi.mock("@/lib/runtime/settings", () => ({
  resolveRuntimeFrontendUrl: mockResolveRuntimeFrontendUrl,
}));

vi.mock("@/lib/capacitor/platform", () => ({
  isNative: mockIsNative,
  isIOS: mockIsIOS,
}));

vi.mock("@/lib/utils/browser-navigation", () => ({
  openExternalUrl: mockOpenExternalUrl,
}));

import {
  WALLET_CARD_API_PREFIX,
  WALLET_CARD_PUBLIC_PATH_PREFIX,
  WALLET_CARD_SERVICE_COPY,
  WalletCardPayloadError,
  WalletCardService,
  canAddToAppleWallet,
  isAllowedWalletCardUrl,
  isWalletShareTokenShape,
  validateWalletCardPayload,
  walletCardPassUrl,
  walletCardShareUrl,
  walletPassCapability,
} from "@/lib/services/wallet-card-service";

const SHARE_TOKEN = "wallet-card-test-token-not-a-real-secret";
const APP_ORIGIN = "https://one.hushh.ai";
const BACKEND_ORIGIN = "https://api.hushh.ai";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36";

function setUserAgent(userAgent: string, maxTouchPoints = 0): void {
  Object.defineProperty(window.navigator, "userAgent", {
    value: userAgent,
    configurable: true,
  });
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    value: maxTouchPoints,
    configurable: true,
  });
}

/** Minimal Response stand-in for the `.pkpass` availability probe. */
function fetchResponse(
  status: number,
  body?: unknown,
  contentType = "application/json",
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
    json: async () => body,
  } as unknown as Response;
}

const OWNER_CARD = {
  passSerial: "6f2f0e6a-6d5e-4b0a-9f0a-0d1c2b3a4e5f",
  status: "active",
  shareTokenVersion: 2,
  cardPayload: { full_name: "Ada Lovelace", headline: "Founder, Hussh" },
  displayName: "Ada Lovelace",
  headline: "Founder, Hussh",
  avatarUrl: null,
  expiresAt: null,
  createdAt: "2026-08-01T00:00:00+00:00",
  updatedAt: "2026-08-02T00:00:00+00:00",
  revokedAt: null,
  lastScannedAt: null,
  scanCount: 4,
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mockResolveRuntimeFrontendUrl.mockReturnValue(APP_ORIGIN);
  mockGetDirectBackendUrl.mockReturnValue(BACKEND_ORIGIN);
  mockIsNative.mockReturnValue(false);
  mockIsIOS.mockReturnValue(false);
  setUserAgent(IPHONE_UA);
});

afterEach(() => {
  window.localStorage.clear();
});

// ==================== URL builders ====================

describe("wallet card URL builders", () => {
  it("builds the public card URL the QR encodes from the configured app origin", () => {
    expect(walletCardShareUrl(SHARE_TOKEN)).toBe(
      `${APP_ORIGIN}${WALLET_CARD_PUBLIC_PATH_PREFIX}/${SHARE_TOKEN}`,
    );
  });

  it("builds the pkpass URL against the backend, not the JSON proxy", () => {
    expect(walletCardPassUrl(SHARE_TOKEN)).toBe(
      `${BACKEND_ORIGIN}${WALLET_CARD_API_PREFIX}/pass/${SHARE_TOKEN}.pkpass`,
    );
  });

  it("trims a trailing slash off the configured backend origin", () => {
    mockGetDirectBackendUrl.mockReturnValue(`${BACKEND_ORIGIN}/`);

    expect(walletCardPassUrl(SHARE_TOKEN)).toBe(
      `${BACKEND_ORIGIN}${WALLET_CARD_API_PREFIX}/pass/${SHARE_TOKEN}.pkpass`,
    );
  });

  it("falls back to a relative path inside the native shell with nothing configured", () => {
    mockIsNative.mockReturnValue(true);
    mockResolveRuntimeFrontendUrl.mockReturnValue("");
    mockGetDirectBackendUrl.mockReturnValue("");

    expect(walletCardShareUrl(SHARE_TOKEN)).toBe(`/c/${SHARE_TOKEN}`);
    expect(walletCardPassUrl(SHARE_TOKEN)).toBe(
      `${WALLET_CARD_API_PREFIX}/pass/${SHARE_TOKEN}.pkpass`,
    );
  });

  it("never interpolates a raw token into a path segment unescaped", () => {
    expect(walletCardShareUrl("a/../../etc")).toBe(
      `${APP_ORIGIN}/c/${encodeURIComponent("a/../../etc")}`,
    );
  });

  it("shape-checks share tokens before they are sent or trusted", () => {
    expect(isWalletShareTokenShape(SHARE_TOKEN)).toBe(true);
    expect(isWalletShareTokenShape("short")).toBe(false);
    expect(isWalletShareTokenShape("has spaces in it and is long enough")).toBe(false);
    expect(isWalletShareTokenShape("../../etc/passwd/aaaaaaaaaaaa")).toBe(false);
    expect(isWalletShareTokenShape("")).toBe(false);
  });
});

// ==================== Platform capability ====================

describe("wallet pass platform capability", () => {
  it("reports capacitor_ios inside the native iOS shell", () => {
    mockIsNative.mockReturnValue(true);
    mockIsIOS.mockReturnValue(true);

    expect(walletPassCapability()).toBe("capacitor_ios");
    expect(canAddToAppleWallet()).toBe(true);
  });

  it("reports unsupported inside the native Android shell", () => {
    mockIsNative.mockReturnValue(true);
    mockIsIOS.mockReturnValue(false);

    expect(walletPassCapability()).toBe("unsupported");
    expect(canAddToAppleWallet()).toBe(false);
  });

  it("reports ios_web in mobile Safari", () => {
    setUserAgent(IPHONE_UA);

    expect(walletPassCapability()).toBe("ios_web");
  });

  it("treats a touch-capable iPadOS desktop user agent as ios_web", () => {
    setUserAgent(MAC_UA, 5);

    expect(walletPassCapability()).toBe("ios_web");
  });

  it("reports unsupported on desktop and on Android web", () => {
    setUserAgent(MAC_UA, 0);
    expect(walletPassCapability()).toBe("unsupported");

    setUserAgent(ANDROID_UA, 5);
    expect(walletPassCapability()).toBe("unsupported");
    expect(canAddToAppleWallet()).toBe(false);
  });

  it("offers the share link instead of Apple Wallet off-iOS", async () => {
    setUserAgent(ANDROID_UA);

    const result = await WalletCardService.addToAppleWallet(SHARE_TOKEN);

    expect(result).toEqual({
      state: "unsupported",
      message: "Apple Wallet is available on iPhone and iPad.",
      shareUrl: walletCardShareUrl(SHARE_TOKEN),
    });
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("hands the pass URL to the OS on iOS rather than loading it in the WebView", async () => {
    setUserAgent(IPHONE_UA);

    const result = await WalletCardService.addToAppleWallet(SHARE_TOKEN, {
      verifyFirst: false,
    });

    expect(result).toEqual({
      state: "opened",
      url: walletCardPassUrl(SHARE_TOKEN),
    });
    expect(mockOpenExternalUrl).toHaveBeenCalledWith(walletCardPassUrl(SHARE_TOKEN));
  });
});

// ==================== Public resolve — typed states ====================

describe("resolvePublicCard", () => {
  it("returns the visitor projection without any authorization header", async () => {
    mockApiJson.mockResolvedValueOnce({
      status: "active",
      card: {
        fullName: "Ada Lovelace",
        headline: "Founder, Hussh",
        organisation: "Hussh Labs",
        locationLabel: "Mumbai, India",
        summary: "Builds private agents.",
        skills: ["Python", "Cryptography"],
        email: "ada@example.com",
        phone: "+91 99999 90000",
        website: "https://ada.example.com",
        linkedin: "https://www.linkedin.com/in/ada",
        github: "https://github.com/ada",
        portfolio: "https://ada.example.com/work",
        preferredContact: "email",
        avatarUrl: "https://cdn.example.com/ada.png",
        updatedOn: "2026-08-02",
      },
    });

    const result = await WalletCardService.resolvePublicCard(SHARE_TOKEN);

    expect(result.state).toBe("available");
    if (result.state !== "available") throw new Error("expected available");
    expect(result.card.full_name).toBe("Ada Lovelace");
    expect(result.card.skills).toEqual(["Python", "Cryptography"]);
    expect(result.card.preferred_contact).toBe("email");

    const [path, init] = mockApiJson.mock.calls[0] ?? [];
    expect(path).toBe(`${WALLET_CARD_API_PREFIX}/public/${SHARE_TOKEN}`);
    expect((init as Record<string, unknown> | undefined)?.headers).toBeUndefined();
  });

  it("maps 410 revoked and 410 expired to distinct typed results", async () => {
    mockApiJson.mockRejectedValueOnce(
      new MockApiError("gone", 410, { status: "revoked" }),
    );
    const revoked = await WalletCardService.resolvePublicCard(SHARE_TOKEN);

    mockApiJson.mockRejectedValueOnce(
      new MockApiError("gone", 410, { status: "expired" }),
    );
    const expired = await WalletCardService.resolvePublicCard(SHARE_TOKEN);

    expect(revoked).toEqual({
      state: "revoked",
      message: "This profile is no longer shared.",
    });
    expect(expired).toEqual({
      state: "expired",
      message: "This profile link has expired.",
    });
    expect(revoked.state).not.toBe(expired.state);
    expect(revoked).not.toEqual(expired);
    expect(WALLET_CARD_SERVICE_COPY.revoked).toBe("This profile is no longer shared.");
    expect(WALLET_CARD_SERVICE_COPY.expired).toBe("This profile link has expired.");
  });

  it("reads the gone status out of a FastAPI detail envelope too", async () => {
    mockApiJson.mockRejectedValueOnce(
      new MockApiError("gone", 410, { detail: { status: "expired" } }),
    );

    expect(await WalletCardService.resolvePublicCard(SHARE_TOKEN)).toEqual({
      state: "expired",
      message: "This profile link has expired.",
    });
  });

  it("returns the same not_found state for an unknown and a paused card", async () => {
    mockApiJson.mockRejectedValueOnce(
      new MockApiError("missing", 404, { status: "not_found" }),
    );
    const unknown = await WalletCardService.resolvePublicCard(SHARE_TOKEN);

    // A paused card is served as the identical generic 404 (contract §6).
    mockApiJson.mockRejectedValueOnce(
      new MockApiError("missing", 404, { status: "not_found" }),
    );
    const paused = await WalletCardService.resolvePublicCard(SHARE_TOKEN);

    expect(unknown).toEqual(paused);
    expect(unknown.state).toBe("not_found");
  });

  it("rejects a malformed token locally without spending a request", async () => {
    const result = await WalletCardService.resolvePublicCard("nope");

    expect(result.state).toBe("not_found");
    expect(mockApiJson).not.toHaveBeenCalled();
  });

  it("degrades to unavailable on a transient failure", async () => {
    mockApiJson.mockRejectedValueOnce(new Error("network down"));

    expect(await WalletCardService.resolvePublicCard(SHARE_TOKEN)).toEqual({
      state: "unavailable",
      message: "This profile could not be loaded right now.",
    });
  });

  it("drops an unsafe link that somehow reached the wire", async () => {
    mockApiJson.mockResolvedValueOnce({
      status: "active",
      card: {
        fullName: "Ada Lovelace",
        website: "javascript:alert(1)",
        portfolio: "https://user:pw@evil.example",
        avatarUrl: "data:text/html;base64,PHNjcmlwdD4=",
      },
    });

    const result = await WalletCardService.resolvePublicCard(SHARE_TOKEN);

    if (result.state !== "available") throw new Error("expected available");
    expect(result.card.website).toBeNull();
    expect(result.card.portfolio).toBeNull();
    expect(result.card.avatar_url).toBeNull();
  });
});

// ==================== Pass availability ====================

describe("checkPassAvailability", () => {
  it("returns the download URL when the pass builds", async () => {
    mockApiFetch.mockResolvedValueOnce(
      fetchResponse(200, undefined, "application/vnd.apple.pkpass"),
    );

    expect(await WalletCardService.checkPassAvailability(SHARE_TOKEN)).toEqual({
      state: "available",
      url: walletCardPassUrl(SHARE_TOKEN),
    });
    expect(mockApiFetch).toHaveBeenCalledWith(
      `${WALLET_CARD_API_PREFIX}/pass/${SHARE_TOKEN}.pkpass`,
      { method: "GET", cache: "no-store" },
    );
  });

  it("surfaces the contract copy when signing material is absent", async () => {
    mockApiFetch.mockResolvedValueOnce(
      fetchResponse(503, {
        status: "unavailable",
        code: "WALLET_PASS_SIGNING_UNAVAILABLE",
        message: "We couldn't create your Wallet pass right now. Please try again in a moment.",
      }),
    );

    expect(await WalletCardService.checkPassAvailability(SHARE_TOKEN)).toEqual({
      state: "signing_unavailable",
      message:
        "We couldn't create your Wallet pass right now. Please try again in a moment.",
      code: "WALLET_PASS_SIGNING_UNAVAILABLE",
    });
  });

  it("maps the pass route's 410 states the same way the card route does", async () => {
    mockApiFetch.mockResolvedValueOnce(fetchResponse(410, { status: "revoked" }));
    const revoked = await WalletCardService.checkPassAvailability(SHARE_TOKEN);

    mockApiFetch.mockResolvedValueOnce(fetchResponse(410, { status: "expired" }));
    const expired = await WalletCardService.checkPassAvailability(SHARE_TOKEN);

    expect(revoked.state).toBe("revoked");
    expect(expired.state).toBe("expired");
  });

  it("returns not_found for an unknown or paused token", async () => {
    mockApiFetch.mockResolvedValueOnce(fetchResponse(404, { status: "not_found" }));

    expect(await WalletCardService.checkPassAvailability(SHARE_TOKEN)).toEqual({
      state: "not_found",
      message: "This profile is not available.",
    });
  });
});

// ==================== Payload validation ====================

describe("validateWalletCardPayload", () => {
  it("accepts the full allowlist and normalises whitespace", () => {
    const result = validateWalletCardPayload({
      full_name: "  Ada Lovelace  ",
      headline: "Founder, Hussh",
      organisation: "Hussh Labs",
      location_label: "Mumbai, India",
      summary: "Builds private agents.",
      skills: ["Python", " Cryptography ", ""],
      email: "ada@example.com",
      phone: "+91 99999 90000",
      website: "https://ada.example.com",
      linkedin: "https://www.linkedin.com/in/ada",
      github: "https://github.com/ada",
      portfolio: "https://ada.example.com/work",
      preferred_contact: "email",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.full_name).toBe("Ada Lovelace");
    expect(result.value.skills).toEqual(["Python", "Cryptography"]);
  });

  it("rejects a key outside the allowlist rather than dropping it", () => {
    const result = validateWalletCardPayload({
      full_name: "Ada Lovelace",
      vault_key: "secret",
      user_id: "user_123",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    const fields = result.errors.map((error) => error.field);
    expect(fields).toEqual(["card_payload", "card_payload"]);
    expect(result.errors[0].message).toContain("vault_key");
  });

  it("enforces the per-field length caps", () => {
    const tooLong = validateWalletCardPayload({ full_name: "a".repeat(81) });
    const atCap = validateWalletCardPayload({ full_name: "a".repeat(80) });
    const summaryTooLong = validateWalletCardPayload({ summary: "s".repeat(401) });

    expect(tooLong.ok).toBe(false);
    expect(atCap.ok).toBe(true);
    expect(summaryTooLong.ok).toBe(false);
  });

  it("caps skills at twelve entries of forty characters", () => {
    const tooMany = validateWalletCardPayload({
      skills: Array.from({ length: 13 }, (_, index) => `skill-${index}`),
    });
    const atCap = validateWalletCardPayload({
      skills: Array.from({ length: 12 }, (_, index) => `skill-${index}`),
    });
    const tooLong = validateWalletCardPayload({ skills: ["x".repeat(41)] });

    expect(tooMany.ok).toBe(false);
    expect(atCap.ok).toBe(true);
    expect(tooLong.ok).toBe(false);
  });

  it("accepts https links only and refuses javascript, data and userinfo forms", () => {
    expect(isAllowedWalletCardUrl("https://ada.example.com")).toBe(true);
    expect(isAllowedWalletCardUrl("http://ada.example.com")).toBe(false);
    expect(isAllowedWalletCardUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedWalletCardUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isAllowedWalletCardUrl("https://ada@evil.example")).toBe(false);
    expect(isAllowedWalletCardUrl("https://user:pw@evil.example")).toBe(false);
    expect(isAllowedWalletCardUrl("  ")).toBe(false);

    for (const key of ["website", "linkedin", "github", "portfolio"]) {
      expect(validateWalletCardPayload({ [key]: "javascript:alert(1)" }).ok).toBe(false);
      expect(validateWalletCardPayload({ [key]: "https://ok.example" }).ok).toBe(true);
    }
  });

  it("validates the email and phone shapes", () => {
    expect(validateWalletCardPayload({ email: "ada@example.com" }).ok).toBe(true);
    expect(validateWalletCardPayload({ email: "ada@example" }).ok).toBe(false);
    expect(validateWalletCardPayload({ email: "not an email" }).ok).toBe(false);
    expect(validateWalletCardPayload({ phone: "+91 99999 90000" }).ok).toBe(true);
    expect(validateWalletCardPayload({ phone: "call me" }).ok).toBe(false);
  });

  it("restricts preferred_contact to the closed set", () => {
    expect(validateWalletCardPayload({ preferred_contact: "email" }).ok).toBe(true);
    expect(validateWalletCardPayload({ preferred_contact: "carrier_pigeon" }).ok).toBe(
      false,
    );
  });

  it("refuses to send an invalid payload to the backend", async () => {
    await expect(
      WalletCardService.saveCard({
        vaultOwnerToken: "vault-token",
        userId: "user_123",
        payload: { full_name: "Ada", vault_key: "secret" },
      }),
    ).rejects.toBeInstanceOf(WalletCardPayloadError);

    expect(mockApiJson).not.toHaveBeenCalled();
  });
});

// ==================== Owner routes ====================

describe("owner routes", () => {
  it("sends the vault owner token and the owner user_id on read", async () => {
    mockApiJson.mockResolvedValueOnce({ card: OWNER_CARD });

    const state = await WalletCardService.getCard({
      vaultOwnerToken: "vault-token",
      userId: "user_123",
    });

    expect(state.enabled).toBe(true);
    expect(state.exists).toBe(true);
    expect(state.card?.status).toBe("active");
    expect(state.card?.scanCount).toBe(4);

    const [path, init] = mockApiJson.mock.calls[0] ?? [];
    expect(path).toBe(`${WALLET_CARD_API_PREFIX}?user_id=user_123`);
    expect(
      (init as { headers: Record<string, string> }).headers.Authorization,
    ).toBe("Bearer vault-token");
  });

  it("reports the feature as disabled instead of throwing", async () => {
    mockApiJson.mockRejectedValueOnce(
      new MockApiError("disabled", 404, {
        detail: { code: "ONE_WALLET_CARD_DISABLED", message: "not available" },
      }),
    );

    expect(
      await WalletCardService.getCard({
        vaultOwnerToken: "vault-token",
        userId: "user_123",
      }),
    ).toEqual({ enabled: false, exists: false, card: null, shareUrl: null });
  });

  it("returns the plaintext token exactly once, on create and on rotate", async () => {
    mockApiJson.mockResolvedValueOnce({
      card: OWNER_CARD,
      shareToken: SHARE_TOKEN,
      shareUrl: `${APP_ORIGIN}/c/${SHARE_TOKEN}`,
    });
    const created = await WalletCardService.saveCard({
      vaultOwnerToken: "vault-token",
      userId: "user_123",
      payload: { full_name: "Ada Lovelace" },
    });

    mockApiJson.mockResolvedValueOnce({ card: OWNER_CARD });
    const paused = await WalletCardService.pauseCard({
      vaultOwnerToken: "vault-token",
      userId: "user_123",
    });

    expect(created.shareToken).toBe(SHARE_TOKEN);
    expect(created.shareUrl).toBe(`${APP_ORIGIN}/c/${SHARE_TOKEN}`);
    expect(created.passUrl).toBe(walletCardPassUrl(SHARE_TOKEN));
    expect(paused.status).toBe("active");
  });

  it("persists the share link locally because the server cannot return it again", async () => {
    mockApiJson.mockResolvedValueOnce({
      card: OWNER_CARD,
      shareToken: SHARE_TOKEN,
      shareUrl: `${APP_ORIGIN}/c/${SHARE_TOKEN}`,
    });

    await WalletCardService.rotateShareToken({
      vaultOwnerToken: "vault-token",
      userId: "user_123",
    });

    expect(WalletCardService.readShareLink("user_123")).toEqual({
      shareUrl: `${APP_ORIGIN}/c/${SHARE_TOKEN}`,
      shareToken: SHARE_TOKEN,
      version: OWNER_CARD.shareTokenVersion,
    });
  });

  it("drops a locally stored link once the token has been rotated elsewhere", () => {
    WalletCardService.rememberShareLink("user_123", {
      card: { ...OWNER_CARD, shareTokenVersion: 2 } as never,
      shareToken: SHARE_TOKEN,
      shareUrl: `${APP_ORIGIN}/c/${SHARE_TOKEN}`,
    });

    const stale = WalletCardService.readShareLink("user_123", {
      ...OWNER_CARD,
      shareTokenVersion: 3,
    } as never);
    const current = WalletCardService.readShareLink("user_123", {
      ...OWNER_CARD,
      shareTokenVersion: 2,
    } as never);

    expect(stale).toBeNull();
    expect(current?.shareToken).toBe(SHARE_TOKEN);
  });

  it("forgets the stored link when the card is revoked", async () => {
    WalletCardService.rememberShareLink("user_123", {
      card: OWNER_CARD as never,
      shareToken: SHARE_TOKEN,
      shareUrl: `${APP_ORIGIN}/c/${SHARE_TOKEN}`,
    });
    mockApiJson.mockResolvedValueOnce({
      card: { ...OWNER_CARD, status: "revoked", revokedAt: "2026-08-03T00:00:00+00:00" },
    });

    const card = await WalletCardService.revokeCard({
      vaultOwnerToken: "vault-token",
      userId: "user_123",
    });

    expect(card.status).toBe("revoked");
    expect(WalletCardService.readShareLink("user_123")).toBeNull();
  });

  it("previews as a visitor through the shared projection contract", async () => {
    mockApiJson.mockResolvedValueOnce({
      status: "active",
      card: { fullName: "Ada Lovelace", updatedOn: "2026-08-02" },
    });

    const result = await WalletCardService.previewAsVisitor({
      vaultOwnerToken: "vault-token",
      userId: "user_123",
    });

    expect(result.state).toBe("available");
    const [path] = mockApiJson.mock.calls[0] ?? [];
    expect(path).toBe(`${WALLET_CARD_API_PREFIX}/preview?user_id=user_123`);
  });

  it("fails loudly rather than inventing a card from an unreadable response", async () => {
    mockApiJson.mockResolvedValueOnce(null);

    await expect(
      WalletCardService.pauseCard({
        vaultOwnerToken: "vault-token",
        userId: "user_123",
      }),
    ).rejects.toMatchObject({ status: 502 });
  });
});
