/**
 * Kai Plugin Interface
 *
 * Native plugin for Agent Kai stock analysis.
 * Separate plugin for modularity and customization.
 *
 * Authentication:
 * - All consent-gated operations use VAULT_OWNER token
 * - Token proves both identity (user_id) and consent (vault unlocked)
 * - Firebase is only used for bootstrap (issuing VAULT_OWNER token)
 */

import { registerPlugin } from "@capacitor/core";

export interface KaiPlugin {
  /**
   * Grant consent for Kai analysis
   * Calls: POST /api/kai/consent/grant
   * Note: This is a bootstrap operation - may need Firebase auth initially
   */
  grantConsent(options: {
    userId: string;
    scopes: string[];
    /**
     * Firebase ID token (bootstrap auth) required by backend for /api/kai/consent/grant.
     */
    authToken?: string;
    /**
     * Preferred name for Firebase ID token.
     * Alias of authToken for migration.
     */
    idToken?: string;
    /**
     * Deprecated: VAULT_OWNER token is not accepted by the backend for this endpoint.
     * Kept only for backward compatibility during migration.
     */
    vaultOwnerToken?: string;
  }): Promise<{ token: string; expires_at: string }>;

  /**
   * Analyze stock ticker
   * Calls: POST /api/kai/analyze
   * Requires: VAULT_OWNER token
   */
  analyze(options: {
    userId: string;
    ticker: string;
    consentToken: string;
    riskProfile: string;
    processingMode: string;
    context?: any;
    vaultOwnerToken?: string;
  }): Promise<any>; // Returns the full analysis response

  /**
   * Get initial chat state for proactive welcome flow.
   * Calls: GET /api/kai/chat/initial-state/:userId
   * Requires: VAULT_OWNER token
   */
  getInitialChatState(options: {
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<{
    is_new_user: boolean;
    has_portfolio: boolean;
    has_financial_data: boolean;
    welcome_type: string;
    total_attributes: number;
    available_domains: string[];
  }>;

  /**
   * Send a chat message to Kai.
   * Calls: POST /api/kai/chat
   * Requires: VAULT_OWNER token
   */
  chat(options: {
    userId: string;
    message: string;
    conversationId?: string;
    vaultOwnerToken: string;
  }): Promise<{
    response: string;
    conversationId: string;
    timestamp: string;
  }>;

  /**
   * Import portfolio from brokerage statement file.
   * Calls: POST /api/kai/portfolio/import
   * Requires: VAULT_OWNER token
   *
   * Accepts CSV or PDF files from major brokerages (Schwab, Fidelity, Robinhood).
   * Returns parsed portfolio data with losers/winners analysis.
   *
   * Note: On native platforms, file must be passed as base64-encoded content
   * since Capacitor plugins cannot directly handle File objects.
   */
  importPortfolio(options: {
    userId: string;
    /** Base64-encoded file content (for native) or File object (web only) */
    fileBase64?: string;
    /** Original filename with extension (e.g., "portfolio.csv") */
    fileName: string;
    /** MIME type of the file */
    mimeType: string;
    /** VAULT_OWNER token for authentication */
    vaultOwnerToken: string;
  }): Promise<{
    success: boolean;
    holdings_count: number;
    total_value: number;
    losers: Array<{
      symbol: string;
      name: string;
      gain_loss_pct: number;
      gain_loss: number;
    }>;
    winners: Array<{
      symbol: string;
      name: string;
      gain_loss_pct: number;
      gain_loss: number;
    }>;
    kpis_stored: string[];
    portfolio_data?: {
      holdings: Array<{
        symbol: string;
        name: string;
        quantity: number;
        current_price: number;
        market_value: number;
        cost_basis?: number;
        gain_loss?: number;
        gain_loss_pct?: number;
      }>;
      kpis: Record<string, unknown>;
    };
    source: string;
    error?: string;
  }>;

  /**
   * Analyze portfolio losers with Renaissance rubric.
   * Calls: POST /api/kai/portfolio/analyze-losers
   * Requires: VAULT_OWNER token
   */
  analyzePortfolioLosers(options: {
    userId: string;
    losers: Array<{
      symbol: string;
      name?: string;
      gain_loss_pct?: number;
      gain_loss?: number;
      market_value?: number;
    }>;
    thresholdPct?: number;
    maxPositions?: number;
    vaultOwnerToken: string;
  }): Promise<{
    criteria_context: string;
    summary: Record<string, unknown>;
    losers: Array<Record<string, unknown>>;
    portfolio_level_takeaways: string[];
  }>;

  /**
   * Stream portfolio import (SSE) from native to avoid WKWebView fetch buffering.
   * Subscribe to events via Kai.addListener('portfolioStreamEvent', handler).
   * Resolves when stream ends.
   */
  streamPortfolioImport(options: {
    userId: string;
    fileBase64: string;
    fileName: string;
    mimeType: string;
    vaultOwnerToken: string;
  }): Promise<{ success: boolean }>;

  /**
   * Resume an existing portfolio import run stream from a cursor.
   * Subscribe to events via Kai.addListener('portfolioStreamEvent', handler).
   * Resolves when stream ends.
   */
  streamPortfolioImportRun(options: {
    runId: string;
    userId: string;
    cursor?: number;
    vaultOwnerToken: string;
  }): Promise<{ success: boolean }>;

  /**
   * Stream portfolio analyze-losers (SSE) from native.
   * Subscribe to events via Kai.addListener('portfolioStreamEvent', handler).
   * Resolves when stream ends.
   */
  streamPortfolioAnalyzeLosers(options: {
    body: Record<string, unknown>;
    vaultOwnerToken: string;
  }): Promise<{ success: boolean }>;

  /**
   * Stream Kai stock analysis (SSE) from native.
   * Subscribe to events via Kai.addListener('kaiStreamEvent', handler).
   * Resolves when stream ends.
   */
  streamKaiAnalysis(options: {
    body: Record<string, unknown>;
    vaultOwnerToken: string;
  }): Promise<{ success: boolean }>;

  /**
   * Subscribe to plugin events (e.g. portfolioStreamEvent, kaiStreamEvent).
   * Event payload is canonical shape: { event, data, id }.
   */
  addListener(
    eventName: string,
    listenerFunc: (event: Record<string, unknown>) => void
  ): Promise<{ remove: () => void }>;
}

/** Event name for native portfolio SSE events (import + analyze-losers). */
export const PORTFOLIO_STREAM_EVENT = "portfolioStreamEvent";

/** Event name for native Kai analysis SSE events (debate stream). */
export const KAI_STREAM_EVENT = "kaiStreamEvent";

export const Kai = registerPlugin<KaiPlugin>("Kai", {
  web: () => import("./plugins/kai-web").then((m) => new m.KaiWeb()),
});
