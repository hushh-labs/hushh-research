import { describe, expect, it } from "vitest";
import { parseDrivePackageDisclosure } from "@/lib/consent/drive-package-disclosure";
import { parseRequesterPaymentView } from "@/lib/consent/document-request-payment-view";

const disclosure = { schemaVersion: 1, packageDigest: "b".repeat(64), packageRevision: 2,
  selectedCount: 2, coverageStatus: "partial", periods: [{ start: "2026-09-01", end: "2026-09-30" }],
  limitations: ["Missing coverage: October 1–9, 2026."] };
describe("approved buyer packet disclosure", () => {
  it("retains only the approved DTO fields", () => {
    expect(parseDrivePackageDisclosure({ ...disclosure, excludedFile: "private.pdf", narrative: "secret" })).toEqual(disclosure);
  });
  it.each([
    { schemaVersion: 2 }, { packageDigest: "invalid" }, { packageRevision: 0 }, { selectedCount: 121 },
    { periods: [{ start: "2026-02-30", end: "2026-03-01" }] },
    { periods: [{ start: "2026-10-09", end: "2026-09-01" }] },
    { limitations: [5] }, { limitations: Array(25).fill("gap") }, { limitations: ["g".repeat(301)] },
    { coverageStatus: "partial", limitations: [] }, { coverageStatus: "unknown", limitations: [] },
  ])("rejects malformed disclosure %o", change => {
    expect(parseDrivePackageDisclosure({ ...disclosure, ...change })).toBeNull();
  });
  it("preserves the required marker when details are missing or malformed", () => {
    const view = { state: "payable", amountCents: 125, currency: "usd", nextAction: "pay",
      checkoutExpiresAt: "2026-10-13T22:00:00Z", packageDisclosureRequired: true,
      packageDisclosure: { ...disclosure, packageDigest: "invalid" } };
    expect(parseRequesterPaymentView(view)).toMatchObject({ packageDisclosureRequired: true, packageDisclosure: null });
  });
});
