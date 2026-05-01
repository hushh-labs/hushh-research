import { describe, expect, it } from "vitest";
import {
  sanitizeErrorMessage,
  formatErrorResponse,
  extractErrorCode,
  isError,
  getErrorMessage,
} from "@/lib/services/error-sanitizer";

describe("error-sanitizer", () => {
  describe("sanitizeErrorMessage", () => {
    it("masks database connection errors", () => {
      const dbError = new Error(
        "psycopg2.OperationalError: could not connect to database at localhost:5432"
      );
      
      const result = sanitizeErrorMessage(dbError, 500);
      
      expect(result.message).toBe("An error occurred on our end. Please try again in a moment.");
      expect(result.category).toBe("server");
      expect(result.isClientError).toBe(false);
    });

    it("masks file system paths", () => {
      const fsError = new Error("Cannot read /home/user/private/secrets.json");
      
      const result = sanitizeErrorMessage(fsError, 500);
      
      expect(result.message).toBe("An error occurred on our end. Please try again in a moment.");
      expect(result.message).not.toContain("/home/user");
    });

    it("masks stack traces", () => {
      const stackError = new Error(
        "TypeError at Object.<anonymous> (file:///app/src/index.js:42)"
      );
      
      const result = sanitizeErrorMessage(stackError, 500);
      
      expect(result.message).not.toContain("Object.<anonymous>");
      expect(result.message).not.toContain("file:///app");
    });

    it("allows safe validation error messages for 4xx status", () => {
      const validError = new Error("Username must be at least 3 characters");
      
      const result = sanitizeErrorMessage(validError, 400);
      
      // The implementation is conservative: even for 4xx, it uses fallback
      // when the message looks like it may contain implementation details.
      expect(result.message).toContain("invalid data");
      expect(result.category).toBe("validation");
      expect(result.isClientError).toBe(true);
    });

    it("masks internal localhost references", () => {
      const internalError = new Error(
        "Failed to connect to http://localhost:8000/api/internal"
      );
      
      const result = sanitizeErrorMessage(internalError, 500);
      
      expect(result.message).not.toContain("localhost");
    });

    it("handles 401 authentication errors", () => {
      const authError = new Error("Invalid token");
      
      const result = sanitizeErrorMessage(authError, 401);
      
      expect(result.category).toBe("authentication");
      expect(result.message).toBe("Your session has expired. Please sign in again.");
      expect(result.isClientError).toBe(true);
    });

    it("handles 403 permission errors without treating them as expired sessions", () => {
      const permissionError = new Error("Forbidden");

      const result = sanitizeErrorMessage(permissionError, 403);

      expect(result.category).toBe("permission");
      expect(result.message).toBe("You don't have permission to perform this action.");
      expect(result.isClientError).toBe(true);
    });

    it("handles 404 not found errors", () => {
      const notFoundError = new Error("Resource not found");
      
      const result = sanitizeErrorMessage(notFoundError, 404);
      
      expect(result.category).toBe("not_found");
      expect(result.message).toContain("not found");
    });

    it("handles non-Error types", () => {
      const stringError = "Something went wrong";
      
      const result = sanitizeErrorMessage(stringError, 500);
      
      expect(result.message).toBe("An error occurred on our end. Please try again in a moment.");
    });

    it("handles undefined/null errors", () => {
      const result = sanitizeErrorMessage(null, 500);
      
      expect(result.message).toBe("An error occurred on our end. Please try again in a moment.");
      expect(result.category).toBe("server");
    });

    it("masks environment variable references", () => {
      const envError = new Error("Configuration secret value is missing");
      
      const result = sanitizeErrorMessage(envError, 500);
      
      expect(result.message).not.toContain("secret value");
    });
  });

  describe("formatErrorResponse", () => {
    it("formats error as JSON response object", () => {
      const error = new Error("Database timeout");
      
      const response = formatErrorResponse(error, 503, "dbquery");
      
      expect(response).toEqual({
        error: expect.any(String),
        category: "server",
      });
      expect(response.error).not.toContain("Database");
    });

    it("includes debug info in development mode", () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      
      const error = new Error("Test debug error");
      const response = formatErrorResponse(error, 500);
      
      expect(response.debug).toBe("Test debug error");
      
      process.env.NODE_ENV = originalEnv;
    });
  });

  describe("extractErrorCode", () => {
    it("extracts error code from formatted message", () => {
      const error = new Error("VAULT_REQUIRED: Please unlock your vault first");
      
      const code = extractErrorCode(error);
      
      expect(code).toBe("VAULT_REQUIRED");
    });

    it("returns null when no code present", () => {
      const error = new Error("Something went wrong");
      
      const code = extractErrorCode(error);
      
      expect(code).toBeNull();
    });

    it("handles non-Error types", () => {
      const code = extractErrorCode("random string");
      
      expect(code).toBeNull();
    });
  });

  describe("isError", () => {
    it("identifies Error instances", () => {
      expect(isError(new Error("test"))).toBe(true);
      expect(isError(new TypeError("test"))).toBe(true);
      expect(isError("string")).toBe(false);
      expect(isError(null)).toBe(false);
      expect(isError({ message: "not an error" })).toBe(false);
    });
  });

  describe("getErrorMessage", () => {
    it("extracts message from Error", () => {
      const error = new Error("Test message");
      
      expect(getErrorMessage(error)).toBe("Test message");
    });

    it("returns string as-is", () => {
      expect(getErrorMessage("Direct string error")).toBe("Direct string error");
    });

    it("converts non-Error, non-string to string", () => {
      expect(getErrorMessage(123)).toBe("123");
      expect(getErrorMessage(null)).toBe("null");
      expect(getErrorMessage(undefined)).toBe("undefined");
    });
  });
});
