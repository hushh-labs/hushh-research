/**
 * Typed client for the stateless Plaid passthrough at `/api/kai/plaid/vault`.
 *
 * The server keeps nothing: the access token comes out of the person's vault
 * for each call and goes back into it. Rules this file keeps:
 * - Every call carries the vault-owner token; there is no Firebase fallback.
 * - No retries. `exchange` in particular is single-shot: a public token can be
 *   exchanged once, and a retried exchange could mint a second item.
 * - Tokens are never logged, and error messages are redacted before they
 *   leave this module.
 */

import { ApiService } from "@/lib/services/api-service";

import type {
  PlaidVaultExchangeResponse,
  PlaidVaultLinkTokenRequest,
  PlaidVaultLinkTokenResponse,
  PlaidVaultRemoveResponse,
  PlaidVaultSnapshot,
} from "@/lib/kai/plaid-vault/types";

export const PLAID_VAULT_BASE_PATH = "/api/kai/plaid/vault";

export type PlaidVaultEndpoint = "link-token" | "exchange" | "snapshot" | "remove";

const FALLBACK_MESSAGES: Record<PlaidVaultEndpoint, string> = {
  "link-token": "Plaid could not start the connection flow right now.",
  exchange: "Plaid could not finish connecting this account.",
  snapshot: "Plaid could not refresh this connection right now.",
  remove: "Plaid could not disconnect this account right now.",
};

// Plaid token shapes: access-<env>-<uuid>, public-<env>-<uuid>, link-<env>-<uuid>,
// plus our own vault-owner tokens (HCT:...). None may appear in an error.
const TOKEN_PATTERNS: RegExp[] = [
  /\b(?:access|public|link)-(?:sandbox|development|production)-[A-Za-z0-9-]+/g,
  /HCT:[A-Za-z0-9._~+/=-]+/g,
  /Bearer\s+[A-Za-z0-9._~+/=:-]+/gi,
];

export function redactTokens(text: string): string {
  return TOKEN_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, "[redacted]"), text);
}

export class PlaidVaultError extends Error {
  readonly status: number;
  readonly endpoint: PlaidVaultEndpoint;

  constructor(endpoint: PlaidVaultEndpoint, status: number, message: string) {
    super(redactTokens(message));
    this.name = "PlaidVaultError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const raw = await response.text().catch(() => "");
  if (!raw || raw.trim().startsWith("<")) return fallback;
  try {
    const payload = JSON.parse(raw) as Record<string, unknown> | null;
    const detail = payload?.detail;
    if (typeof detail === "string" && detail.trim()) return detail.trim();
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      const message = (detail as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
    const message = payload?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
    return fallback;
  } catch {
    return fallback;
  }
}

function requireToken(value: string, label: string): string {
  const token = String(value || "").trim();
  if (!token) throw new Error(`${label} is required.`);
  return token;
}

async function post<T>(
  endpoint: PlaidVaultEndpoint,
  vaultOwnerToken: string,
  body: Record<string, unknown>
): Promise<T> {
  const token = requireToken(vaultOwnerToken, "A vault-owner token");
  let response: Response;
  try {
    response = await ApiService.apiFetch(`${PLAID_VAULT_BASE_PATH}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : FALLBACK_MESSAGES[endpoint];
    throw new PlaidVaultError(endpoint, 0, message || FALLBACK_MESSAGES[endpoint]);
  }
  if (!response.ok) {
    const message = await readErrorMessage(response, FALLBACK_MESSAGES[endpoint]);
    throw new PlaidVaultError(endpoint, response.status, message);
  }
  return (await response.json()) as T;
}

export async function createVaultLinkToken(params: {
  vaultOwnerToken: string;
  request: PlaidVaultLinkTokenRequest;
}): Promise<PlaidVaultLinkTokenResponse> {
  // Plaid's Android SDK rejects a redirect URI beside the package name.
  const redirectUri =
    params.request.platform === "android" ? null : params.request.redirect_uri ?? null;
  const body: Record<string, unknown> = {
    platform: params.request.platform,
    redirect_uri: redirectUri,
  };
  // This is an opt-in local proof marker, not an environment selector. Omit
  // it from every ordinary client request to preserve the public contract.
  if (params.request.sandbox_proof === true) body.sandbox_proof = true;
  return post<PlaidVaultLinkTokenResponse>("link-token", params.vaultOwnerToken, body);
}

/** Single-shot. Never call twice for the same public token. */
export async function exchangeVaultPublicToken(params: {
  vaultOwnerToken: string;
  publicToken: string;
}): Promise<PlaidVaultExchangeResponse> {
  const publicToken = requireToken(params.publicToken, "A Plaid public token");
  return post<PlaidVaultExchangeResponse>("exchange", params.vaultOwnerToken, {
    public_token: publicToken,
  });
}

export async function fetchVaultSnapshot(params: {
  vaultOwnerToken: string;
  accessToken: string;
  transactionsCursor?: string | null;
}): Promise<PlaidVaultSnapshot> {
  const accessToken = requireToken(params.accessToken, "A Plaid access token");
  return post<PlaidVaultSnapshot>("snapshot", params.vaultOwnerToken, {
    access_token: accessToken,
    transactions_cursor: params.transactionsCursor ?? null,
  });
}

export async function removeVaultItem(params: {
  vaultOwnerToken: string;
  accessToken: string;
}): Promise<PlaidVaultRemoveResponse> {
  const accessToken = requireToken(params.accessToken, "A Plaid access token");
  return post<PlaidVaultRemoveResponse>("remove", params.vaultOwnerToken, {
    access_token: accessToken,
  });
}
