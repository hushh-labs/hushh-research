import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodePayload } from "@/components/wallet-card/__tests__/qr-code-test-decoder";
import { buildWalletCardSvg, createWalletCardImageFile, walletCardImageKey } from "@/lib/wallet/wallet-card-image";

vi.mock("@/lib/services/wallet-card-artwork-service", () => ({
  loadWalletCardArtwork: vi.fn(async (kind: string) => readFileSync(join(process.cwd(), `public/wallet/artwork/${kind}-v3.svg`), "utf8")),
}));

const profile = { ownerId: "owner-a", displayName: "Old display name", cardPayload: { full_name: "Ankit Kumar Singh", username: "ankit.kumar.singh" }, memberSince: "2021-04-14T00:00:00Z", walletId: "wallet-1234abcd", shareUrl: "https://one.hushh.ai/c/profile-test-token", referralUrl: "https://one.hushh.ai/r/referral-test-slug" };

function qrPayload(document: Document): string {
  const qr = document.querySelector("[data-wallet-qr]")!;
  const size = Number(qr.getAttribute("viewBox")!.split(" ")[2]) - 8;
  const modules = new Uint8Array(size * size);
  for (const run of qr.querySelector("path")!.getAttribute("d")!.matchAll(/M(\d+) (\d+)h(\d+)v1H\d+z/g)) {
    for (let x = Number(run[1]) - 4; x < Number(run[1]) - 4 + Number(run[3]); x += 1) modules[(Number(run[2]) - 4) * size + x] = 1;
  }
  return decodePayload({ size, modules });
}

beforeEach(() => vi.clearAllMocks());
describe("Wallet card image composition", () => {
  it.each(["profile", "referral"] as const)("embeds the complete %s artwork, live fields, and independently decodable correct QR", async (kind) => {
    const svg = await buildWalletCardSvg({ kind, profile });
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(document.querySelector("parsererror")).toBeNull();
    expect(document.querySelector("image")?.getAttribute("href")).toMatch(/^data:image\/png;base64,/);
    expect(document.querySelector("style")?.textContent).toContain("data:font/woff2;base64,");
    expect(document.querySelector("style")?.textContent).toContain("WalletJakarta");
    expect(document.querySelector("[data-wallet-identity]")?.textContent).toContain("Ankit Kumar Singh");
    expect(document.querySelector("[data-wallet-identity]")?.textContent).toContain("2021");
    expect(qrPayload(document)).toBe(kind === "profile" ? profile.shareUrl : profile.referralUrl);
  });

  it("keeps NWS sample 900 and no QR in the face or export", async () => {
    const svg = await buildWalletCardSvg({ kind: "nws", profile });
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(document.querySelector("[data-wallet-identity]")?.textContent).toContain("Ankit Kumar Singh");
    expect(document.querySelector("text.score")?.textContent).toBe("900");
    expect(document.querySelector("[data-wallet-qr]")).toBeNull();
  });

  it("escapes owner values and never reuses a previous owner or rotated QR identity", async () => {
    const other = { ...profile, ownerId: "owner-b", cardPayload: { full_name: '<script>bad</script>' }, shareUrl: "https://one.hushh.ai/c/new-profile-token" };
    const svg = await buildWalletCardSvg({ kind: "profile", profile: other });
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(document.querySelector("script")).toBeNull();
    expect(qrPayload(document)).toBe(other.shareUrl);
    expect(walletCardImageKey("profile", other)).not.toBe(walletCardImageKey("profile", profile));
    expect(walletCardImageKey("profile", { ...profile, ownerId: "owner-b" })).not.toBe(walletCardImageKey("profile", profile));
  });

  it("rejects cancelled image work and refuses a share image before its live link exists", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(buildWalletCardSvg({ kind: "profile", profile, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await expect(createWalletCardImageFile({ kind: "profile", profile: { ...profile, shareUrl: null } })).rejects.toThrow("not ready");
  });
});


it("renders only the permitted identity in a timed shared face, even if extra owner fields are supplied", async () => {
  const shared = { ...profile, presentation: "shared" as const };
  const svg = await buildWalletCardSvg({ kind: "profile", profile: shared });
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  expect(document.querySelector("[data-wallet-shared]")?.textContent).toContain("Ankit Kumar Singh");
  expect(document.querySelector("[data-wallet-qr]")).toBeNull();
  expect(document.querySelector("[data-wallet-qr-frame]")).toBeNull();
  expect(svg).not.toContain("MEMBER SINCE");
  expect(svg).not.toContain("WALLET ID");
  expect(svg).not.toContain("1234ABCD");
  expect(svg).not.toContain(profile.shareUrl);
  expect(walletCardImageKey("profile", shared)).not.toBe(walletCardImageKey("profile", profile));
});
