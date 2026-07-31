import { VaultService } from "@/lib/services/vault-service";

const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

interface EnsureKaiTokenOptions {
  userId: string;
  currentToken: string | null;
  currentExpiresAt: number | null;
  forceRefresh?: boolean;
  onIssued?: (token: string, expiresAt: number) => void;
}

function hasUsableToken(token: string | null, expiresAt: number | null): boolean {
  if (!token || !expiresAt) return false;
  return Date.now() + TOKEN_REFRESH_BUFFER_MS < expiresAt;
}

export function isKaiAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

export async function ensureKaiVaultOwnerToken(
  options: EnsureKaiTokenOptions
): Promise<string> {
  if (!options.forceRefresh && hasUsableToken(options.currentToken, options.currentExpiresAt)) {
    return options.currentToken as string;
  }

  const issued = await VaultService.getOrIssueVaultOwnerToken(
    options.userId,
    options.forceRefresh ? null : options.currentToken,
    options.forceRefresh ? null : options.currentExpiresAt
  );

  options.onIssued?.(issued.token, issued.expiresAt);
  return issued.token;
}

