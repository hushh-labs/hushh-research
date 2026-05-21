// __tests__/utils/mock-tokens.ts

/**
 * Mock Token Utilities for Testing
 *
 * Provides valid and invalid token representations for testing
 * consent protocol compliance.
 */

// Valid test tokens (format matches HCT:base64.signature)
export const VALID_TOKENS = {
  // Session token with pkm.read scope
  session:
    "HCT:dGVzdF91c2VyfHRlc3RfYWdlbnR8cGttLnJlYWR8MTcwMzAwMDAwMDAwMHwxNzAzMDg2NDAwMDAw.valid_signature",
};

// Invalid test tokens
export const INVALID_TOKENS = {
  // Expired token
  expired:
    "HCT:dGVzdF91c2VyfHRlc3RfYWdlbnR8cGttLnJlYWR8MTcwMjAwMDAwMDAwMHwxNzAyMDAwMDAwMDAx.expired_signature",

  // Wrong signature
  badSignature:
    "HCT:dGVzdF91c2VyfHRlc3RfYWdlbnR8cGttLnJlYWR8MTcwMzAwMDAwMDAwMHwxNzAzMDg2NDAwMDAw.invalid_signature",

  // Wrong format
  malformed: "INVALID_TOKEN_FORMAT",

  // Revoked token
  revoked: "HCT:cmV2b2tlZF90b2tlbg.revoked_signature",
};

// Test user IDs
export const TEST_USERS = {
  valid: "test_user",
  admin: "admin_user",
  unauthorized: "unauthorized_user",
};

/**
 * Create mock backend validation response
 */
export function mockValidationResponse(
  valid: boolean,
  options: {
    userId?: string;
    agentId?: string;
    scope?: string;
    reason?: string;
  } = {}
) {
  return {
    valid,
    user_id: options.userId || "test_user",
    agent_id: options.agentId || "test_agent",
    scope: options.scope || "pkm.read",
    reason: options.reason,
  };
}

/**
 * Create mock Firebase auth header
 */
export function mockFirebaseHeader(userId?: string): string {
  if (!userId) return "Bearer DEV_TOKEN";
  return `Bearer firebase_token_for_${userId}`;
}
