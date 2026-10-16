import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { encodeCardPng, decodeCardPng, flattenCardTransparency, type CardRaster } from "@/lib/wallet/card-scan-raster";
import { validateCardImage, cardProjection, cardCameraCaptureBox, FULL_CARD } from "@/lib/wallet/card-scan-image";
import { spatialCardNumbers } from "@/lib/wallet/card-scan-spatial";
import { parseCardScanReading, mergeCardScanReadings } from "@/lib/wallet/card-scan-fields";
import { approveWalletPhoto, assertWalletArtworkApproval, registerInspectedWalletPhoto } from "@/lib/wallet/card-artwork";
import { snapshotVaultSessionEpoch, advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { projectWalletConsent } from "@/lib/wallet/card-consent-projection";
import { projectDomainDataForScope } from "@/lib/personal-knowledge-model/manifest";
import { excludePrivatePkmDomains, isPrivatePkmExportScope } from "@/lib/consent/pkm-scope-policy";
import { reservedEntryFor } from "@/lib/pkm/reserved-branches";
import { walletOperationId } from "@/lib/wallet/wallet-operation-id";

const raster = (width = 32, height = 20): CardRaster => ({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) });
beforeEach(() => { vi.stubGlobal("Blob", NodeBlob); vi.stubGlobal("crypto", webcrypto); publishValidatedAuthSessionOwner("synthetic-owner"); });
afterEach(() => vi.unstubAllGlobals());

describe("independent, conservative local observations", () => {
  it("never manufactures a 12-digit PAN by dropping the short final group of a 13-digit number", () => {
    const row = ["4222", "2222", "2222", "2"].map((text, index) => ({ text, confidence: 90, bbox: { x0: index * 100, x1: index * 100 + (text.length === 1 ? 15 : 60), y0: 0, y1: 30 } }));
    expect(spatialCardNumbers(row)).toEqual(["4222222222222"]);
    row[3]!.confidence = 30;
    expect(spatialCardNumbers(row)).toEqual([]);
  });
  it("captures exactly the visible camera guide for portrait and landscape sensors", () => {
    // A 4:3 sensor shown in the landscape card preview loses top/bottom pixels.
    expect(cardCameraCaptureBox(1600, 1200, 400, 250)).toEqual({ x: 128, y: 180, width: 1344, height: 840 });
    // A portrait sensor loses still more vertical pixels, without cropping sides twice.
    expect(cardCameraCaptureBox(1200, 1600, 300, 187.5)).toEqual({ x: 96, y: 485, width: 1008, height: 630 });
  });
  it("can create a canonical operation ID when the browser lacks randomUUID", () => {
    vi.stubGlobal("crypto", { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    expect(walletOperationId()).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  });
  it("preserves clear fields when PAN is absent and excludes unrelated marketing", () => {
    expect(parseCardScanReading("VALID THRU 12/30\nALEX SAMPLE").fields).toEqual({ expiry: "12/30", cardholderName: "ALEX SAMPLE" });
    expect(parseCardScanReading("LOUNGE ACCESS").fields).toEqual({});
    expect(parseCardScanReading("ISSUED 11/24\nEXPIRY 12/30").fields.expiry).toBe("12/30");
  });
  it("retains ambiguity through a second merge and keeps other readable fields", () => {
    const a = parseCardScanReading("4242424242424242\n4111111111111111\n12/30"), b = parseCardScanReading("4242424242424242\n12/30");
    const composed = mergeCardScanReadings([mergeCardScanReadings([a, b]), b]);
    expect(composed.fields.pan).toBeUndefined(); expect(composed.states.pan).toBe("needs_review"); expect(composed.fields.expiry).toBe("12/30");
  });
  it("does not discard a valid PAN because another pass has invalid digits", () => {
    expect(mergeCardScanReadings([parseCardScanReading("4242424242424242"), parseCardScanReading("4242424242424243")]).fields.pan).toBe("4242424242424242");
    const invalid = mergeCardScanReadings([parseCardScanReading("4242424242424243"), parseCardScanReading("4242424242424244")]);
    expect(mergeCardScanReadings([invalid, parseCardScanReading("4242424242424242")]).fields.pan).toBe("4242424242424242");
  });
  it("does not join transcript-only groups that might include a security code", () => {
    expect(parseCardScanReading("4242\n4242\n4242\n4242\n12/30").fields.pan).toBeUndefined();
    expect(parseCardScanReading("4242424242424242O1\nEXPIRY 12/30").fields).toEqual({ expiry: "12/30" });
    expect(parseCardScanReading("EXPIRY 12/30\nÉLOÏSE D’ARMAGNAC").fields.cardholderName).toBe("ÉLOÏSE D’ARMAGNAC");
  });
  it("uses neighboring glyph geometry, excluding a distant four-digit code", () => {
    const items = [0, 1, 2, 3].map(index => ({ text: "4242", confidence: 95, bbox: { x0: index * 110, x1: index * 110 + 95, y0: 100, y1: 140 } }));
    const values = spatialCardNumbers([...items, { text: "1234", confidence: 95, bbox: { x0: 850, x1: 945, y0: 300, y1: 340 } }]);
    expect(values).toContain("4242424242424242"); expect(values.some(value => value.includes("1234"))).toBe(false);
  });
  it("preserves review status for an uncorroborated name", () => {
    const result = mergeCardScanReadings([parseCardScanReading("12/30\nALEX SAMPLE")]); expect(result.fields.cardholderName).toBe("ALEX SAMPLE"); expect(result.states.cardholderName).toBe("needs_review");
  });
  it.each(["horizontal", "vertical"])("never extracts a 16-digit prefix from an overlong %s number", direction => {
    const items = Array.from({ length: 5 }, (_, index) => ({ text: "4242", confidence: 95, bbox: direction === "horizontal" ? { x0: index * 110, x1: index * 110 + 95, y0: 100, y1: 140 } : { x0: 100, x1: 195, y0: index * 60, y1: index * 60 + 40 } }));
    expect(spatialCardNumbers(items)).toEqual([]);
  });
});

describe("encoded raster and image bounds", () => {
  it("removes invisible RGB information and alpha before flattening final bytes", async () => {
    const image = { width: 2, height: 1, data: new Uint8ClampedArray([42, 19, 73, 0, 55, 99, 100, 0]) };
    flattenCardTransparency(image);
    expect(Array.from((await decodeCardPng(await encodeCardPng(image))).data)).toEqual([255, 255, 255, 255, 255, 255, 255, 255]);
  });
  it("encodes only pixels, round-trips final bytes and omits hidden metadata", async () => {
    const original = raster(), blob = await encodeCardPng(original), bytes = new Uint8Array(await blob.arrayBuffer());
    expect(await decodeCardPng(blob)).toEqual(original); expect(await validateCardImage(blob)).toBeUndefined();
    const chunks: string[] = []; const view = new DataView(bytes.buffer); for (let offset = 8; offset < bytes.length;) { chunks.push(new TextDecoder().decode(bytes.slice(offset + 4, offset + 8))); offset += view.getUint32(offset) + 12; }
    expect(chunks).toEqual(["IHDR", "IDAT", "IEND"]);
  });
  it.each([[450, 284], [284, 450]])("keeps %sx%s fallback PNG within budget without browser compression", async (width, height) => {
    vi.stubGlobal("CompressionStream", undefined); vi.stubGlobal("DecompressionStream", undefined);
    const image = raster(width, height), blob = await encodeCardPng(image); expect(blob.size).toBeLessThan(512 * 1024); expect(await decodeCardPng(blob)).toEqual(image);
  });
  it("rejects oversized decoded dimensions before starting image decoding", async () => {
    const bytes = new Uint8Array(24); bytes.set([137, 80, 78, 71]); const view = new DataView(bytes.buffer); view.setUint32(16, 10000); view.setUint32(20, 10000);
    await expect(validateCardImage(new Blob([bytes], { type: "image/png" }))).rejects.toThrow("24 megapixels");
  });
  it("maps the perspective quadrilateral corners without changing the source", () => {
    const points = [{ x: .1, y: .1 }, { x: .8, y: .2 }, { x: .9, y: .8 }, { x: .05, y: .9 }] as typeof FULL_CARD;
    expect(cardProjection(points, 0, 0)).toEqual(points[0]); expect(cardProjection(points, 1, 1).x).toBeCloseTo(points[2].x);
  });
});

describe("owner-bound approval and private projections", () => {
  it("rejects a raw uninspected photo and a forged approval object", async () => {
    const blob = await encodeCardPng(raster()); await expect(approveWalletPhoto(blob, "synthetic-owner")).rejects.toThrow("Inspect");
    registerInspectedWalletPhoto(blob, "synthetic-owner", snapshotVaultSessionEpoch()); const artwork = await approveWalletPhoto(blob, "synthetic-owner");
    expect(() => assertWalletArtworkApproval(artwork, "synthetic-owner")).not.toThrow(); expect(() => assertWalletArtworkApproval({ ...artwork }, "synthetic-owner")).toThrow();
  });
  it("cannot rebind an old inspection to a different owner or vault epoch", async () => {
    const blob = await encodeCardPng(raster()); registerInspectedWalletPhoto(blob, "synthetic-owner", snapshotVaultSessionEpoch());
    publishValidatedAuthSessionOwner("different-owner"); await expect(approveWalletPhoto(blob, "different-owner")).rejects.toThrow();
    publishValidatedAuthSessionOwner("synthetic-owner"); advanceVaultSessionEpoch(); await expect(approveWalletPhoto(blob, "synthetic-owner")).rejects.toThrow();
  });
  it("invalidates approved bytes on lock and never trusts a mutated reference", async () => {
    const blob = await encodeCardPng(raster()); registerInspectedWalletPhoto(blob, "synthetic-owner", snapshotVaultSessionEpoch()); const artwork = await approveWalletPhoto(blob, "synthetic-owner"); advanceVaultSessionEpoch(); expect(() => assertWalletArtworkApproval(artwork, "synthetic-owner")).toThrow();
  });
  it("excludes art, codes and receipts from historical/mixed-case consent projections", () => {
    const input = { summary: { card_1: { last4: "4242", brand: "visa", extra: "do not export" } }, secrets: { card_1: { pan: "4242424242424242", cardholder_name: "SYNTHETIC OWNER", cvv: "code-sentinel", manual_cvv: "manual-code-sentinel", pin: "pin-sentinel", share_receipts: ["receipt-sentinel"] } }, artwork: { card_1: { image: "art-sentinel" } } };
    const safe = projectWalletConsent(input); expect(JSON.stringify(safe)).not.toMatch(/sentinel|do not export/); expect(safe).toHaveProperty("secrets.card_1.pan");
    const result = projectDomainDataForScope({ domain: "Wallet", scope: "pkm.read", domainData: input }); expect(JSON.stringify(result)).not.toMatch(/sentinel/);
    expect(excludePrivatePkmDomains({ Wallet: input, professional: { name: "kept" } })).toEqual({ professional: { name: "kept" } });
    expect(isPrivatePkmExportScope("attr.wallet.artwork.*")).toBe(true); expect(isPrivatePkmExportScope("attr.wallet.summary.*")).toBe(false); expect(input.artwork.card_1.image).toBe("art-sentinel");
    expect(reservedEntryFor("wallet", "artwork.card_1")?.sendToModel).toBe("never");
  });
});
