/**
 * Regression suite — @/lib/services/error-sanitizer
 *
 * Covers the canonical API error-sanitisation boundary used across
 * hushh-webapp API routes and server actions.
 *
 * CWE-209 guard: every test in the "sensitive pattern leakage prevention"
 * section asserts that a specific SENSITIVE_PATTERNS entry does not surface
 * in client-facing output. A regression on any single entry fails CI in
 * isolation so the broken pattern is immediately pinpointed.
 *
 * Implementation: hushh-webapp/lib/services/error-sanitizer.ts
 * Test surface:   hushh-webapp/__tests__/lib/services/error-sanitizer.test.ts
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractErrorCode,
  formatErrorResponse,
  getErrorMessage,
  isError,
  sanitizeErrorMessage,
} from "@/lib/services/error-sanitizer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function err(message: string): Error {
  return new Error(message);
}

// ---------------------------------------------------------------------------
// Sensitive pattern leakage — CWE-209 regression coverage
// One test per SENSITIVE_PATTERNS entry so regressions are pinpointed.
// ---------------------------------------------------------------------------

describe("sanitizeErrorMessage — sensitive pattern leakage prevention", () => {
  // — Database internals —
  it.each([
    ["psycopg2 error: SSL connection failed"],
    ["postgres: could not connect to server"],
    ["sql syntax error near SELECT"],
    ["database connection pool exhausted"],
    ["query timeout exceeded after 30 000ms"],
    ["table users does not exist"],
    ["column email violates not-null constraint"],
    ["constraint violation: unique_users_email"],
  ])("redacts database detail: %s", (rawMessage) => {
    const result = sanitizeErrorMessage(err(rawMessage), 500);
    expect(result.message).not.toMatch(
      /psycopg2|postgres|sql|database|query|table|column|constraint/i
    );
    expect(result.message).toBeTruthy();
    expect(result.category).toBe("server");
  });

  // — File system paths —
  it.each([
    ["/home/ubuntu/app/secrets.json not found"],
    ["/var/log/app.log permission denied"],
    ["/opt/service/config.yaml missing"],
    ["/etc/ssl/certs/ca.pem not readable"],
    ["/proc/1234/mem access denied"],
    ["/sys/kernel/debug unavailable"],
  ])("redacts file system path: %s", (rawMessage) => {
    const result = sanitizeErrorMessage(err(rawMessage), 500);
    expect(result.message).not.toMatch(
      /\/home\/|\/var\/|\/opt\/|\/etc\/|\/proc\/|\/sys\//i
    );
  });

  // — Internal hosts and IPs —
  it.each([
    ["Connection to localhost:5432 refused"],
    ["Cannot reach 127.0.0.1:8080"],
    ["Service at 10.0.2.2:3000 timed out"],
    ["Redis at 192.168.1.50:6379 unreachable"],
    ["Internal mesh node 172.16.0.10 returned 503"],
  ])("redacts internal host/IP: %s", (rawMessage) => {
    const result = sanitizeErrorMessage(err(rawMessage), 500);
    expect(result.message).not.toMatch(
      /localhost|127\.0\.0\.1|10\.0\.2\.2|192\.168\.|172\.16\./i
    );
  });

  // — Stack trace fragments —
  it.each([
    ["TypeError: Cannot read property 'x'\n    at Object.eval (eval.js:12:4)"],
    ["stack trace: TypeError at processRequest"],
    ["Module loaded from file:///app/dist/index.js"],
  ])("redacts stack trace fragment: %s", (rawMessage) => {
    const result = sanitizeErrorMessage(err(rawMessage), 500);
    expect(result.message).not.toMatch(/at |stack trace|file:\/\//i);
  });

  // — Environment variable references —
  it.each([
    ["process.env.DATABASE_URL is not defined"],
    ["ENV[STRIPE_SECRET_KEY] is missing"],
    ["PRIVATE_KEY not configured in environment"],
    ["SECRET value resolved to null"],
  ])("redacts env var reference: %s", (rawMessage) => {
    const result = sanitizeErrorMessage(err(rawMessage), 500);
    expect(result.message).not.toMatch(/process\.env|ENV\[|PRIVATE_KEY|SECRET/i);
  });

  // — Internal function names and line numbers —
  it.each([
    ["Object.<anonymous> threw at line 99"],
    ["_internal_parse failed unexpectedly"],
    ["Uncaught at handler.js:42:18"],
  ])("redacts internal function/line reference: %s", (rawMessage) => {
    const result = sanitizeErrorMessage(err(rawMessage), 500);
    expect(result.message).not.toMatch(/Object\.<|_internal_|\.js:\d+/i);
  });
      it("masks uppercase localhost references", () => {
      const internalError = new Error(
        "Failed to connect to HTTP://LOCALHOST:8000/api/internal"
      );

      const result = sanitizeErrorMessage(internalError, 500);

      expect(result.message).not.toContain("LOCALHOST");
      expect(result.message).not.toContain("localhost");
      expect(result.message).toBe("An error occurred on our end. Please try again in a moment.");
    });
});

// ---------------------------------------------------------------------------
// Error category classification
// ---------------------------------------------------------------------------

describe("sanitizeErrorMessage — error category classification", () => {
  it.each([
    [401, "authentication"],
    [403, "permission"],
    [400, "validation"],
    [422, "validation"],
    [404, "not_found"],
    [409, "conflict"],
    [500, "server"],
    [503, "server"],
    [undefined, "unknown"],
  ] as const)(
    "classifies status %s as category %s",
    (status, expectedCategory) => {
      const result = sanitizeErrorMessage(err("irrelevant"), status);
      expect(result.category).toBe(expectedCategory);
    }
  );

  it("marks 4xx responses as isClientError=true", () => {
    expect(sanitizeErrorMessage(err("bad input"), 400).isClientError).toBe(true);
    expect(sanitizeErrorMessage(err("not found"), 404).isClientError).toBe(true);
  });

  it("marks 5xx responses as isClientError=false", () => {
    expect(sanitizeErrorMessage(err("crash"), 500).isClientError).toBe(false);
  });

  it("marks missing status as isClientError=false", () => {
    expect(
      sanitizeErrorMessage(err("unknown"), undefined).isClientError
    ).toBe(false);
  });
    it("omits debug information outside development mode", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const error = new Error("Hidden production detail");
    const response = formatErrorResponse(error, 500);

    expect(response.debug).toBeUndefined();

    process.env.NODE_ENV = originalEnv;
  });
      it("does not extract error codes with surrounding whitespace", () => {
    const error = new Error(
      "   VAULT_REQUIRED: Please unlock your vault first   "
    );

    const code = extractErrorCode(error);

    expect(code).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Per-category fallback messages — canonical output strings
// ---------------------------------------------------------------------------

describe("sanitizeErrorMessage — per-category fallback messages", () => {
  it("returns server fallback for 500", () => {
    const result = sanitizeErrorMessage(err("psycopg2 crash"), 500);
    expect(result.message).toBe(
      "An error occurred on our end. Please try again in a moment."
    );
  });

  it("returns authentication fallback for 401", () => {
    const result = sanitizeErrorMessage(err("Invalid token"), 401);
    expect(result.message).toBe("Your session has expired. Please sign in again.");
    expect(result.category).toBe("authentication");
    expect(result.isClientError).toBe(true);
  });

  it("returns permission fallback for 403", () => {
    const result = sanitizeErrorMessage(err("Forbidden"), 403);
    expect(result.message).toBe(
      "You don't have permission to perform this action."
    );
    expect(result.category).toBe("permission");
    expect(result.isClientError).toBe(true);
  });

  it("returns not_found fallback for 404", () => {
    const result = sanitizeErrorMessage(err("Resource not found"), 404);
    expect(result.category).toBe("not_found");
    expect(result.message).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// Safe pass-through logic — benign short client error messages
// ---------------------------------------------------------------------------

describe("sanitizeErrorMessage — safe client error pass-through", () => {
  it("preserves short safe validation message from 400 response", () => {
    const safeMessage = "Email address is required";
    const result = sanitizeErrorMessage(err(safeMessage), 400);
    expect(result.message).toBe(safeMessage);
    expect(result.category).toBe("validation");
  });

  it("redacts message longer than 200 characters even on 400", () => {
    const longMessage = "a".repeat(201);
    const result = sanitizeErrorMessage(err(longMessage), 400);
    expect(result.message).not.toBe(longMessage);
    expect(result.message.length).toBeLessThan(201);
  });

  it("always redacts 401 message content — auth errors are always opaque", () => {
    const result = sanitizeErrorMessage(err("Invalid Firebase token"), 401);
    expect(result.message).not.toMatch(/token/i);
    expect(result.category).toBe("authentication");
  });

  it("always redacts 403 message content — permission errors are always opaque", () => {
    const result = sanitizeErrorMessage(err("Access denied for user vault"), 403);
    expect(result.message).not.toMatch(/vault/);
    expect(result.category).toBe("permission");
  });

  it("returns non-empty fallback when Error message is empty string", () => {
    const result = sanitizeErrorMessage(err(""), 500);
    expect(result.message).toBeTruthy();
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("handles plain string input without throwing", () => {
    const result = sanitizeErrorMessage("plain string error", 400);
    expect(result.message).toBeTruthy();
  });

  it("handles non-Error non-string input without throwing", () => {
    const result = sanitizeErrorMessage({ code: 42 }, 500);
    expect(result.message).toBeTruthy();
  });

  it("handles null input without throwing", () => {
    const result = sanitizeErrorMessage(null, 500);
    expect(result.message).toBe(
      "An error occurred on our end. Please try again in a moment."
    );
    expect(result.category).toBe("server");
  });
});

// ---------------------------------------------------------------------------
// formatErrorResponse — shape and NODE_ENV debug-field guard
// ---------------------------------------------------------------------------

describe("formatErrorResponse — NODE_ENV dev-mode debug guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("always includes error and category fields", () => {
    vi.stubEnv("NODE_ENV", "test");
    const result = formatErrorResponse(err("Database timeout"), 503, "dbquery");
    expect(result).toHaveProperty("error");
    expect(result).toHaveProperty("category");
    expect(typeof result.error).toBe("string");
    expect(result.category).toBe("server");
    expect(String(result.error)).not.toContain("Database");
  });

  it("omits debug field when NODE_ENV is test", () => {
    vi.stubEnv("NODE_ENV", "test");
    const result = formatErrorResponse(err("raw internal detail"), 500);
    expect(result).not.toHaveProperty("debug");
  });

  it("omits debug field when NODE_ENV is production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const result = formatErrorResponse(err("raw internal detail"), 500);
    expect(result).not.toHaveProperty("debug");
  });

  it("includes debug field when NODE_ENV is development", () => {
    vi.stubEnv("NODE_ENV", "development");
    const result = formatErrorResponse(err("raw internal detail"), 500);
    expect(result).toHaveProperty("debug");
    expect(result.debug).toBe("raw internal detail");
  });

  it("never exposes raw sensitive message via debug field in test env", () => {
    vi.stubEnv("NODE_ENV", "test");
    const result = formatErrorResponse(err("psycopg2: connection refused"), 500);
    expect(result).not.toHaveProperty("debug");
    expect(String(result.error)).not.toMatch(/psycopg2/i);
  });

  it("debug field in development contains raw Error message", () => {
    vi.stubEnv("NODE_ENV", "development");
    const result = formatErrorResponse(err("VAULT_REQUIRED: key missing"), 500);
    expect(result.debug).toBe("VAULT_REQUIRED: key missing");
  });
});

// ---------------------------------------------------------------------------
// extractErrorCode
// ---------------------------------------------------------------------------

describe("extractErrorCode", () => {
  it("extracts uppercase code prefix from Error message", () => {
    expect(
      extractErrorCode(err("VAULT_REQUIRED: missing vault configuration"))
    ).toBe("VAULT_REQUIRED");
  });

  it("extracts multi-word underscore-separated code", () => {
    expect(extractErrorCode(err("TOKEN_EXPIRED: please refresh"))).toBe(
      "TOKEN_EXPIRED"
    );
  });

  it("returns null when message has no code prefix", () => {
    expect(extractErrorCode(err("something went wrong"))).toBeNull();
  });

  it("returns null for non-Error string input", () => {
    expect(extractErrorCode("not an error")).toBeNull();
  });

  it("returns null for null and undefined", () => {
    expect(extractErrorCode(null)).toBeNull();
    expect(extractErrorCode(undefined)).toBeNull();
  });

  it("returns null for numeric input", () => {
    expect(extractErrorCode(42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isError — type guard
// ---------------------------------------------------------------------------

describe("isError", () => {
  it("returns true for Error instances", () => {
    expect(isError(new Error("test"))).toBe(true);
  });

  it("returns true for Error subclass instances", () => {
    class DomainError extends Error {}
    expect(isError(new DomainError("domain"))).toBe(true);
  });

  it("returns false for plain objects with message property", () => {
    expect(isError({ message: "looks like error" })).toBe(false);
  });

  it("returns false for strings", () => {
    expect(isError("error string")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isError(undefined)).toBe(false);
  });

  it("returns false for numbers", () => {
    expect(isError(404)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getErrorMessage
// ---------------------------------------------------------------------------

describe("getErrorMessage", () => {
  it("returns Error.message for Error instances", () => {
    expect(getErrorMessage(err("specific message"))).toBe("specific message");
  });

  it("returns the string directly for string inputs", () => {
    expect(getErrorMessage("direct string error")).toBe("direct string error");
  });

  it("stringifies numbers", () => {
    expect(getErrorMessage(42)).toBe("42");
  });

  it("stringifies null", () => {
    expect(getErrorMessage(null)).toBe("null");
  });

  it("stringifies objects via String()", () => {
    const result = getErrorMessage({ detail: "x" });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});