import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeQrCode } from "@/components/wallet-card/qr-code";
import {
  EMPTY_WALLET_CARD_IDENTITY,
  resolveWalletProfileStatus,
  buildWalletArtworkMessage,
  buildWalletArtworkQr,
  deriveWalletCardDates,
} from "@/lib/wallet/wallet-card-identity";

describe("deriveWalletCardDates", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ["2026-10-08T04:00:00Z", "2026", "12/28"],
    ["2027-01-01T00:00:00Z", "2027", "12/29"],
    ["Wed, 08 Oct 2026 12:00:00 GMT", "2026", "12/28"],
    [Date.UTC(2024, 2, 5), "2024", "12/26"],
    ["2099-06-01T00:00:00Z", "2099", "12/01"],
  ])("%s joins in %s and is valid through %s", (created, since, thru) => {
    expect(deriveWalletCardDates(created)).toEqual({ memberSince: since, validThru: thru });
  });

  it("reads the joining year in UTC so every device agrees", () => {
    expect(deriveWalletCardDates("2026-12-31T23:30:00Z")?.memberSince).toBe("2026");
    expect(deriveWalletCardDates("2026-12-31T23:30:00-05:00")?.memberSince).toBe("2027");
  });

  it("ends at December of joining year + 2, not 24 months after joining", () => {
    expect(deriveWalletCardDates("2026-02-01T00:00:00Z")?.validThru).toBe("12/28");
    expect(deriveWalletCardDates("2026-12-30T00:00:00Z")?.validThru).toBe("12/28");
  });

  it("never substitutes today's year for a missing or unreadable timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-05-05T00:00:00Z"));
    for (const missing of [undefined, null, "", "not a date", Number.NaN, 0, -5, "Thu, 01 Jan 1970 00:00:00 GMT"]) {
      expect(deriveWalletCardDates(missing)).toBeNull();
    }
    expect(deriveWalletCardDates("2024-03-05T00:00:00Z")?.memberSince).toBe("2024");
  });
});

describe("Wallet artwork QR and messages", () => {
  const profileUrl = "https://one.hushh.ai/c/profile-token-abc123";
  const referralUrl = "https://one.hushh.ai/r/sharukh-ref";

  it("sends the exact modules of a real symbol", () => {
    const qr = buildWalletArtworkQr(profileUrl)!;
    const matrix = encodeQrCode(profileUrl);
    expect(qr.size).toBe(matrix.size);

    const drawn = new Uint8Array(matrix.size * matrix.size);
    for (const [, x, y, width] of qr.d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g).map(
      (m) => [m[0], Number(m[1]), Number(m[2]), Number(m[3])] as const,
    )) {
      for (let i = 0; i < width; i += 1) drawn[y * matrix.size + x + i] = 1;
    }
    expect(drawn).toEqual(matrix.modules);
    expect(qr.d).toMatch(/^(?:M\d+ \d+h\d+v1h-\d+z)+$/);
  });

  it("encodes the profile link on the black card and the referral link on the gold one", () => {
    const identity = { ...EMPTY_WALLET_CARD_IDENTITY, ownerId: "u1", name: "Ada", profileUrl, referralUrl };
    expect(buildWalletArtworkMessage("profile", identity).qr).toEqual(buildWalletArtworkQr(profileUrl));
    expect(buildWalletArtworkMessage("referral", identity).qr).toEqual(buildWalletArtworkQr(referralUrl));
    expect(buildWalletArtworkMessage("referral", identity).qr).not.toEqual(buildWalletArtworkQr(profileUrl));
  });

  it("draws no QR, name or dates when there is nothing to show", () => {
    expect(buildWalletArtworkQr("   ")).toBeNull();
    for (const card of ["profile", "referral"] as const) {
      expect(buildWalletArtworkMessage(card, EMPTY_WALLET_CARD_IDENTITY)).toMatchObject({
        name: null,
        memberSince: null,
        validThru: null,
        qr: null,
      });
    }
    // A profile link must not leak onto the referral card when that link is missing.
    const onlyProfile = { ...EMPTY_WALLET_CARD_IDENTITY, profileUrl };
    expect(buildWalletArtworkMessage("referral", onlyProfile).qr).toBeNull();
  });
});

describe("resolveWalletProfileStatus", () => {
  const live = { enabled: true, exists: true, card: { status: "active" }, shareUrl: "https://one.hushh.ai/c/t" };

  it("maps the server's answer to setup, link-missing or ready", () => {
    expect(resolveWalletProfileStatus(live)).toBe("ready");
    expect(resolveWalletProfileStatus({ ...live, card: { status: "paused" } })).toBe("ready");
    expect(resolveWalletProfileStatus({ ...live, shareUrl: null })).toBe("link-missing");
    expect(resolveWalletProfileStatus({ ...live, shareUrl: "  " })).toBe("link-missing");
    expect(resolveWalletProfileStatus({ ...live, exists: false, card: null, shareUrl: null })).toBe("setup");
    expect(resolveWalletProfileStatus({ ...live, card: { status: "revoked" }, shareUrl: null })).toBe("setup");
  });

  it("does not call a feature that is off an uncreated profile", () => {
    expect(resolveWalletProfileStatus({ enabled: false, exists: false, card: null, shareUrl: null })).toBe("unknown");
  });
});
