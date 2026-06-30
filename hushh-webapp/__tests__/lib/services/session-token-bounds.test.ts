import { describe, expect, it } from "vitest";

/**
 * Characterization: session token extraction bounds on malformed / extreme input.
 *
 * Verified repo truth (truth-first)
 * ---------------------------------
 * The exported public session parsing utility is `extractSessionToken(request:
 * Request): string | null` in `hushh-webapp/lib/auth/validate.ts`. It reads a
 * session token from, in priority order:
 *   1. the `X-Session-Token` header,
 *   2. the `sessionToken` query param,
 *   3. the `Authorization` header *only when it starts with `HCT:`*.
 * When none of those produce a value it returns `null`. It performs no JSON
 * parsing and no signature validation — that is delegated to
 * `validateSessionToken` / the backend. So the genuine "bounds" contract to pin
 * here is: how does extraction behave for empty values, broken/foreign auth
 * headers, JSON-structure characters embedded in the token, and pathologically
 * long segments? The expected clean-failure signal is a `null` return (never a
 * throw, never an `undefined`).
 *
 * The companion `extractConsentToken(body)` helper is also exercised for its
 * null-on-missing contract, since it shares the same "fail cleanly to null"
 * design invariant.
 *
 * The file lives at the requested `__tests__/lib/services/` path per the task
 * instruction even though the source unit is `lib/auth/validate.ts`.
 */

import {
  extractSessionToken,
  extractConsentToken,
} from "@/lib/auth/validate";

function makeRequest(
  url: string,
  headers: Record<string, string> = {}
): Request {
  return new Request(url, { headers });
}

describe("extractSessionToken · malformed and extreme inputs", () => {
  it("returns null for a bare request with no token sources", () => {
    const result = extractSessionToken(makeRequest("https://hushh.app/api/x"));
    expect(result).toBeNull();
  });

  it("returns null when the Authorization header is present but not an HCT token", () => {
    const result = extractSessionToken(
      makeRequest("https://hushh.app/api/x", {
        Authorization: "Bearer eyJhbGciOi.broken.header",
      })
    );
    // Only `HCT:`-prefixed Authorization headers are honored.
    expect(result).toBeNull();
  });

  it("returns null for a Basic auth header (foreign scheme)", () => {
    const result = extractSessionToken(
      makeRequest("https://hushh.app/api/x", {
        Authorization: "Basic dXNlcjpwYXNz",
      })
    );
    expect(result).toBeNull();
  });

  it("returns null when no token source matches even with unrelated query params", () => {
    const result = extractSessionToken(
      makeRequest("https://hushh.app/api/x?foo=bar&token=nope")
    );
    expect(result).toBeNull();
  });

  it("does not throw and returns the raw header even when it embeds JSON-structure characters", () => {
    // Extraction is a transport-layer read; it returns the raw string verbatim.
    // It must never attempt to parse it and must never throw.
    const malformed = '{"alg":"none","x":[}}';
    const result = extractSessionToken(
      makeRequest("https://hushh.app/api/x", {
        "X-Session-Token": malformed,
      })
    );
    expect(result).toBe(malformed);
    expect(typeof result).toBe("string");
  });

  it("honors a well-formed HCT Authorization header as the fallback source", () => {
    const hct = "HCT:eyJ1c2VyIjoiYSJ9.deadbeef";
    const result = extractSessionToken(
      makeRequest("https://hushh.app/api/x", {
        Authorization: hct,
      })
    );
    expect(result).toBe(hct);
  });

  it("prefers the X-Session-Token header over query param and Authorization", () => {
    const result = extractSessionToken(
      makeRequest("https://hushh.app/api/x?sessionToken=fromQuery", {
        "X-Session-Token": "fromHeader",
        Authorization: "HCT:fromAuth",
      })
    );
    expect(result).toBe("fromHeader");
  });

  it("reads the sessionToken query param when no header is present", () => {
    const result = extractSessionToken(
      makeRequest("https://hushh.app/api/x?sessionToken=queryValue")
    );
    expect(result).toBe("queryValue");
  });

  it("does not throw and fails to null for a pathologically long non-matching auth header", () => {
    const huge = "Bearer " + "a".repeat(100_000);
    let result: string | null = "sentinel";
    expect(() => {
      result = extractSessionToken(
        makeRequest("https://hushh.app/api/x", { Authorization: huge })
      );
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it("preserves an extremely long X-Session-Token verbatim without truncation or throwing", () => {
    const huge = "z".repeat(50_000);
    const result = extractSessionToken(
      makeRequest("https://hushh.app/api/x", { "X-Session-Token": huge })
    );
    expect(result).toBe(huge);
    expect(result).toHaveLength(50_000);
  });
});

describe("extractConsentToken · clean null on missing/foreign shapes", () => {
  it("returns null for an empty body", () => {
    expect(extractConsentToken({})).toBeNull();
  });

  it("returns null when only unrelated keys are present", () => {
    expect(extractConsentToken({ foo: "bar", token: 123 })).toBeNull();
  });

  it("reads the camelCase consentToken field", () => {
    expect(extractConsentToken({ consentToken: "HCT:abc.def" })).toBe(
      "HCT:abc.def"
    );
  });

  it("falls back to the snake_case consent_token field", () => {
    expect(extractConsentToken({ consent_token: "HCT:ghi.jkl" })).toBe(
      "HCT:ghi.jkl"
    );
  });
});
