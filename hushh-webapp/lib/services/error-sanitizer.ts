/**
 * Error Sanitizer - Safe error message handling for API responses
 * 
 * Ensures sensitive error details don't leak to client applications.
 * Provides user-friendly fallback messages while preserving backend logging.
 */

/**
 * Sensitive patterns that indicate backend implementation details
 */
const SENSITIVE_PATTERNS = [
  // Database errors
  /psycopg2|postgres|sql|database|query|table|column|constraint/i,
  // File system errors
  /\/home\/|\/var\/|\/opt\/|\/etc\/|\/proc\/|\/sys\//i,
  // Internal URLs/IPs
  /localhost|127\.0\.0\.1|10\.0\.2\.2|192\.168\.|172\.16\./i,
  // Stack traces
  /at |stack trace|file:\/\//i,
  // Environment variables
  /process\.env|ENV\[|PRIVATE_KEY|SECRET/i,
  // Function names and line numbers
  /Object\.<|_internal_|\.js:\d+/i,
];

/**
 * Error type categories with appropriate user messages
 */
type ErrorCategory = 
  | "network"
  | "authentication"
  | "validation"
  | "permission"
  | "not_found"
  | "conflict"
  | "server"
  | "unknown";

interface SanitizedError {
  message: string;
  category: ErrorCategory;
  isClientError: boolean;
}

/**
 * Categorize HTTP status code
 */
function getErrorCategory(status?: number): ErrorCategory {
  if (!status) return "unknown";
  
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 400 || status === 422) return "validation";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 500) return "server";
  if (status >= 400) return "validation";
  
  return "unknown";
}

/**
 * Check if error message contains sensitive information
 */
function containsSensitiveInfo(message: string): boolean {
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * Get user-friendly message for error category
 */
function getFallbackMessage(category: ErrorCategory): string {
  const messages: Record<ErrorCategory, string> = {
    network: "Unable to reach the server. Please check your connection and try again.",
    authentication: "Your session has expired. Please sign in again.",
    validation: "The request contained invalid data. Please check your input and try again.",
    permission: "You don't have permission to perform this action.",
    not_found: "The requested resource was not found.",
    conflict: "This action conflicts with your current state. Please refresh and try again.",
    server: "An error occurred on our end. Please try again in a moment.",
    unknown: "Something went wrong. Please try again.",
  };
  
  return messages[category];
}

/**
 * Determine if error is a client error (user's fault) vs server error
 */
function isClientError(status?: number): boolean {
  return status ? (status >= 400 && status < 500) : false;
}

/**
 * Sanitize error message from exception
 * Returns safe message for client display while preserving backend logging
 */
export function sanitizeErrorMessage(
  error: unknown,
  status?: number,
  context?: string
): SanitizedError {
  const category = getErrorCategory(status);
  const isClient = isClientError(status);
  
  // Extract raw message
  let rawMessage = "";
  if (error instanceof Error) {
    rawMessage = error.message || "";
  } else if (typeof error === "string") {
    rawMessage = error;
  } else {
    rawMessage = String(error);
  }

  // Log full error internally for debugging
  if (typeof window === "undefined") {
    // Backend logging (server-side only)
    console.error(`[ErrorSanitizer] Raw error (${category}):`, {
      message: rawMessage,
      stack: error instanceof Error ? error.stack : undefined,
      context,
      status,
    });
  }

  // Determine if message is safe to show
  const isSafe = rawMessage.length > 0 &&
                 rawMessage.length < 200 &&
                 !containsSensitiveInfo(rawMessage) &&
                 isClient &&
                 category !== "authentication" &&
                 category !== "permission";

  const message = isSafe ? rawMessage : getFallbackMessage(category);

  return {
    message,
    category,
    isClientError: isClient,
  };
}

/**
 * Format error for JSON response
 * Usage: JSON.stringify({ error: formatErrorResponse(...) })
 */
export function formatErrorResponse(
  error: unknown,
  status: number,
  context?: string
): Record<string, unknown> {
  const sanitized = sanitizeErrorMessage(error, status, context);
  
  return {
    error: sanitized.message,
    category: sanitized.category,
    ...(process.env.NODE_ENV === "development" && {
      debug: error instanceof Error ? error.message : String(error),
    }),
  };
}

/**
 * Extract and validate error code from backend response
 * Useful for distinguishing between different error types
 */
export function extractErrorCode(error: unknown): string | null {
  if (error instanceof Error) {
    // Try to extract code from error message (e.g., "VAULT_REQUIRED: ...")
    const match = error.message.match(/^([A-Z_]+):/);
    return match ? match[1]! : null;
  }
  
  return null;
}

/**
 * Type guard for Error objects
 */
export function isError(value: unknown): value is Error {
  return value instanceof Error;
}

/**
 * Safe error message getter that handles null/undefined
 */
export function getErrorMessage(error: unknown): string {
  if (isError(error)) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}
