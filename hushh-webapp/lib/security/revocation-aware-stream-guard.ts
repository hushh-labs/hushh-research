export type RevocationLookup = (token: string) => boolean;

export type StreamGuardResult =
  | {
      allowed: true;
      checkedAt: number;
    }
  | {
      allowed: false;
      checkedAt: number;
      reason: "missing_token" | "revoked_token";
    };

export function createRevocationAwareStreamGuard({
  isTokenRevoked,
}: {
  isTokenRevoked: RevocationLookup;
}) {
  return function guardStreamAccess(token?: string | null): StreamGuardResult {
    const checkedAt = Date.now();
    const normalizedToken = token?.trim();

    if (!normalizedToken) {
      return {
        allowed: false,
        checkedAt,
        reason: "missing_token",
      };
    }

    if (isTokenRevoked(normalizedToken)) {
      return {
        allowed: false,
        checkedAt,
        reason: "revoked_token",
      };
    }

    return {
      allowed: true,
      checkedAt,
    };
  };
}