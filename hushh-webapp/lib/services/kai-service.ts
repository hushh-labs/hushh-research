/**
 * Kai Service — Direct Plugin Integration
 *
 * Calls Kai plugin directly for platform-aware backend communication.
 * - Web: Kai plugin uses Next.js API proxy
 * - Mobile: Kai plugin makes native HTTP calls to backend
 *
 * Authentication:
 * - All consent-gated operations use VAULT_OWNER token
 * - Token MUST be passed explicitly from useVault() hook (memory-only, XSS protected)
 * - Firebase token is only used for bootstrap (issuing VAULT_OWNER token)
 * 
 * SECURITY: Token is NEVER read from sessionStorage (XSS protection).
 */

import { Kai } from "@/lib/capacitor/kai";
import { ApiService } from "@/lib/services/api-service";
import { AuthService } from "@/lib/services/auth-service";
import { CacheService, CACHE_KEYS, CACHE_TTL } from "@/lib/services/cache-service";

// ============================================================================
// TYPES
// ============================================================================

export interface GrantConsentResponse {
  token: string;
  expires_at: string;
}

export interface AnalyzeResponse {
  ticker: string;
  decision: "buy" | "hold" | "reduce";
  confidence: number;
  headline: string;
  processing_mode: string;
  created_at?: string; // Optional - may not be in response
  raw_card: Record<string, any>;
}

// ============================================================================
// HELPER - VAULT_OWNER TOKEN (Consent-First)
// ============================================================================

// Token storage for kai-service (set by callers who have access to useVault())
let _cachedVaultOwnerToken: string | undefined;

/**
 * Set the VAULT_OWNER token for kai-service operations.
 * Called by components that have access to useVault() hook.
 * 
 * SECURITY: This is memory-only storage, not sessionStorage.
 */
export function setKaiVaultOwnerToken(token: string | undefined): void {
  _cachedVaultOwnerToken = token;
}

/**
 * Get VAULT_OWNER token from memory cache.
 * 
 * SECURITY: Never reads from sessionStorage (XSS protection).
 * Token must be set via setKaiVaultOwnerToken() by components with useVault() access.
 */
function getVaultOwnerToken(): string | undefined {
  return _cachedVaultOwnerToken;
}

/**
 * Get VAULT_OWNER token or throw if not available.
 * Use this for operations that require consent.
 */
function requireVaultOwnerToken(): string {
  const token = getVaultOwnerToken();
  if (!token) {
    throw new Error("Vault must be unlocked to perform this operation. Call setKaiVaultOwnerToken() first.");
  }
  return token;
}

// ============================================================================
// API CALLS (Via Kai Plugin)
// ============================================================================

/**
 * Grant Kai Consent
 * Note: This is a bootstrap operation that may use Firebase token
 * to issue a consent token. After this, use VAULT_OWNER token.
 */
export async function grantKaiConsent(
  userId: string,
  scopes?: string[]
): Promise<GrantConsentResponse> {
  // grantConsent is a bootstrap operation - backend requires Firebase ID token.
  const idToken = await AuthService.getIdToken();
  if (!idToken) {
    throw new Error("Missing Firebase ID token for Kai consent grant");
  }

  return Kai.grantConsent({
    userId,
    // Updated to use dynamic attr.* scopes instead of legacy vault.read.*/vault.write.*
    scopes: scopes || [
      "attr.financial.risk_profile", // Replaces vault.read.risk_profile
      "agent.kai.analyze",
    ],
    idToken,
    // Back-compat for native implementations still expecting authToken
    authToken: idToken,
  });
}

/**
 * Analyze Ticker
 * Requires VAULT_OWNER token for consent-gated data access.
 */
export async function analyzeTicker(params: {
  user_id: string;
  ticker: string;
  consent_token: string;
  risk_profile: "conservative" | "balanced" | "aggressive";
  processing_mode: "on_device" | "hybrid";
}): Promise<AnalyzeResponse> {
  const vaultOwnerToken = requireVaultOwnerToken();

  const result = await Kai.analyze({
    userId: params.user_id,
    ticker: params.ticker,
    consentToken: params.consent_token,
    riskProfile: params.risk_profile,
    processingMode: params.processing_mode,
    vaultOwnerToken,
  });

  // Plugin returns the full response, just return it
  return result as AnalyzeResponse;
}

/**
 * Get User's Encrypted Investor Profile (Ciphertext)
 *
 * NOTE: `/api/identity/profile` has been removed from the product flow.
 * This helper is kept as a hard-fail to surface any hidden callers.
 */
export async function getEncryptedProfile(_token: string): Promise<{
  profileData: { ciphertext: string; iv: string; tag: string } | null;
}> {
  throw new Error(
    "getEncryptedProfile() is deprecated: /api/identity/profile has been removed from the flow"
  );
}

/**
 * Analyze ticker with fundamental context (decrypted investor profile).
 * Platform-aware: Uses Kai plugin on native, Next.js API on web.
 * Requires VAULT_OWNER token for consent-gated data access.
 */
export async function analyzeFundamental(params: {
  user_id: string;
  ticker: string;
  risk_profile: "conservative" | "balanced" | "aggressive";
  processing_mode: "on_device" | "hybrid";
  context: any;
  token: string;
}): Promise<any> {
  // Use explicit token or memory token from useVault()-fed setter.
  const vaultOwnerToken = params.token || requireVaultOwnerToken();

  // Use Kai plugin (platform-aware)
  return Kai.analyze({
    userId: params.user_id,
    ticker: params.ticker,
    consentToken: params.token,
    riskProfile: params.risk_profile,
    processingMode: params.processing_mode,
    context: params.context, // Include decrypted investor profile context
    vaultOwnerToken,
  });
}

/**
 * Stream Kai analysis (SSE) from backend.
 *
 * NOTE: This is intentionally implemented in the service layer so that
 * components do not call fetch() directly, preserving Tri-Flow rules.
 */
export async function streamKaiAnalysis(params: {
  userId: string;
  ticker: string;
  riskProfile?: string;
  userContext?: string;
  vaultOwnerToken: string;
}): Promise<Response> {
  // SSE streaming is now supported via ApiService.apiFetchStream

  const response = await ApiService.apiFetchStream("/api/kai/analyze/stream", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.vaultOwnerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ticker: params.ticker,
      user_id: params.userId,
      risk_profile: params.riskProfile,
      context: params.userContext,
    }),
  });

  return response;
}

/**
 * Get initial chat state for proactive welcome flow.
 * Platform-aware: Uses Kai plugin on native, Next.js API on web.
 * Requires VAULT_OWNER token for consent-gated data access.
 * 
 * Note: Returns camelCase for React components, transforms from snake_case backend response.
 */
export async function getInitialChatState(userId: string): Promise<{
  isNewUser: boolean;
  hasPortfolio: boolean;
  hasFinancialData: boolean;
  welcomeType: string;
  totalAttributes: number;
  availableDomains: string[];
}> {
  const vaultOwnerToken = requireVaultOwnerToken();

  const result = await Kai.getInitialChatState({
    userId,
    vaultOwnerToken,
  });

  // Transform snake_case to camelCase for React components
   
  const raw = result as any;
  return {
    isNewUser: raw.is_new_user ?? raw.isNewUser ?? true,
    hasPortfolio: raw.has_portfolio ?? raw.hasPortfolio ?? false,
    hasFinancialData: raw.has_financial_data ?? raw.hasFinancialData ?? false,
    welcomeType: raw.welcome_type ?? raw.welcomeType ?? "new",
    totalAttributes: raw.total_attributes ?? raw.totalAttributes ?? 0,
    availableDomains: raw.available_domains ?? raw.availableDomains ?? [],
  };
}

/**
 * Extract user ID from VAULT_OWNER token for caching purposes.
 * Token format: HCT:{base64_user_id}|{agent_info}|{scopes}|{iat}|{exp}.{signature}
 */
function extractUserIdFromToken(token: string): string {
  try {
    // Split the token and get the payload part (second part)
    const parts = token.split(".");
    if (parts.length < 2) return "unknown";
    
    // Get the first part safely
    const firstPart = parts[0];
    if (!firstPart) return "unknown";
    
    // Decode the base64 user_id from the first part
    const payloadBase64 = firstPart.replace("HCT:", "");
    const decoded = atob(payloadBase64);
    // Extract user_id from the JSON-like structure
    const userIdMatch = decoded.match(/"user_id"\s*:\s*"([^"]+)"/);
    return userIdMatch && userIdMatch[1] !== undefined ? userIdMatch[1] : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Get stock context for analysis (holdings, decisions, portfolio allocation).
 * Called before starting analysis to show confirmation dialog.
 * 
 * Uses CacheService (in-memory only) for XSS-safe caching.
 * Caches result for 15 minutes across page navigations.
 * 
 * @param ticker Stock ticker symbol
 * @param vaultOwnerToken VAULT_OWNER consent token (user_id is extracted from token)
 */
export async function getStockContext(
  ticker: string,
  vaultOwnerToken: string
): Promise<{
  ticker: string;
  user_risk_profile: string;
  holdings: Array<{
    symbol: string;
    quantity: number;
    market_value: number;
    weight_pct: number;
  }>;
  recent_decisions: Array<{
    ticker: string;
    decision: "BUY" | "HOLD" | "REDUCE";
    confidence: number;
    timestamp: string;
  }>;
  portfolio_allocation: {
    equities_pct: number;
    bonds_pct: number;
    cash_pct: number;
  };
}> {
  // Extract userId from token for cache key
  const userId = extractUserIdFromToken(vaultOwnerToken);
  const cacheKey = CACHE_KEYS.STOCK_CONTEXT(userId, ticker.toUpperCase());
  
  // Check cache first (in-memory only, XSS-safe)
  const cached = CacheService.getInstance().get<ReturnType<typeof getStockContext>>(cacheKey);
  if (cached) {
    return cached;
  }
  
  const response = await ApiService.apiFetch("/api/pkm/get-context", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${vaultOwnerToken}`,
    },
    body: JSON.stringify({
      ticker: ticker.toUpperCase(),
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Failed to get stock context");
  }

  const data = await response.json();
  
  // Cache for 15 minutes (in-memory only, XSS-safe)
  CacheService.getInstance().set(cacheKey, data, CACHE_TTL.LONG);
  
  return data;
}

/**
 * Send a chat message to Kai.
 * Platform-aware: Uses Kai plugin on native, Next.js API on web.
 * Requires VAULT_OWNER token for consent-gated data access.
 * 
 * Note: Returns camelCase for React components, transforms from snake_case backend response.
 */
export async function chat(params: {
  userId: string;
  message: string;
  conversationId?: string;
}): Promise<{
  response: string;
  conversationId: string;
  timestamp: string;
}> {
  const vaultOwnerToken = requireVaultOwnerToken();

  const result = await Kai.chat({
    userId: params.userId,
    message: params.message,
    conversationId: params.conversationId,
    vaultOwnerToken,
  });

  // Transform snake_case to camelCase for React components
   
  const raw = result as any;
  return {
    response: raw.response || "",
    conversationId: raw.conversation_id || raw.conversationId || "",
    timestamp: raw.timestamp || new Date().toISOString(),
  };
}
