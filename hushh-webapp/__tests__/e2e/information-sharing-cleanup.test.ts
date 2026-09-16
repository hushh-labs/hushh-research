import { describe, expect, it } from "vitest";
import {
  assertCleanupComplete,
  validateCleanupBundle,
} from "../../e2e/helpers/information-sharing-cleanup";

const expected = {
  bundleId: "run-bundle",
  personRef: "owner",
  purpose: "exact-purpose",
  items: [{ requestId: "run-request", scopeRef: "scope" }],
};
const detail = (status: string, cancelled = false) => ({
  ...expected,
  cancelled,
  items: [{ ...expected.items[0], status }],
});

describe("information-sharing cleanup authority", () => {
  it("requires revocation of the authoritative grant even if absent from a paginated center list", () => {
    const bundle = validateCleanupBundle(detail("granted"), expected);
    expect(
      bundle.items.filter((item) => item.status === "granted"),
    ).toHaveLength(1);
    expect(() =>
      assertCleanupComplete(detail("granted", true), expected),
    ).toThrow(/still has access/);
  });
  it.each(["pending", "granted"])(
    "rejects cancellation response retaining %s",
    (status) => {
      expect(() =>
        assertCleanupComplete(detail(status, true), expected),
      ).toThrow();
    },
  );
  it.each(["revoked", "denied", "cancelled", "expired"])(
    "accepts cancelled bundle with terminal %s",
    (status) => {
      expect(() =>
        assertCleanupComplete(detail(status, true), expected),
      ).not.toThrow();
    },
  );
  it("requires persisted bundle cancellation", () => {
    expect(() => assertCleanupComplete(detail("revoked"), expected)).toThrow();
  });
  it("rejects a missing item instead of assuming it is cleaned", () => {
    expect(() =>
      assertCleanupComplete(
        { ...detail("revoked", true), items: [] },
        expected,
      ),
    ).toThrow();
  });
  it("rejects foreign request IDs, owners and unknown states", () => {
    expect(() =>
      validateCleanupBundle(
        { ...detail("granted"), personRef: "foreign" },
        expected,
      ),
    ).toThrow();
    expect(() =>
      validateCleanupBundle(
        {
          ...detail("granted"),
          items: [
            { requestId: "foreign", scopeRef: "scope", status: "granted" },
          ],
        },
        expected,
      ),
    ).toThrow();
    expect(() => validateCleanupBundle(detail("unknown"), expected)).toThrow();
  });
});
