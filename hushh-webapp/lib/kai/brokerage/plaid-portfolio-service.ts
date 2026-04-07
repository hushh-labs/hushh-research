"use client";

import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { ApiService } from "@/lib/services/api-service";
import type {
  PlaidFundingStatusResponse,
  PlaidTransferPayload,
  PlaidPortfolioStatusResponse,
  PortfolioSource,
} from "@/lib/kai/brokerage/portfolio-sources";

export interface PlaidLinkTokenResponse {
  configured: boolean;
  mode: string;
  link_token: string | null;
  expiration?: string | null;
  redirect_uri?: string | null;
  request_id?: string | null;
  resume_session_id?: string | null;
}

export interface PlaidRefreshResponse {
  accepted: boolean;
  runs: Array<Record<string, unknown>>;
}

export interface PlaidTransferCreateResponse {
  approved: boolean;
  decision?: string;
  decision_rationale?: unknown;
  authorization_id?: string | null;
  idempotency_key?: string | null;
  deduped?: boolean;
  action_link_token?: PlaidLinkTokenResponse | null;
  transfer?: PlaidTransferPayload;
  reference?: Record<string, unknown>;
}

export interface PlaidFundingAdminSearchResponse {
  count: number;
  items: Array<Record<string, unknown>>;
}

export interface AlpacaConnectStartResponse {
  configured: boolean;
  authorization_url: string;
  state: string;
  expires_at?: string | null;
  redirect_uri?: string | null;
  oauth_env?: string | null;
}

const PLAID_STATUS_CACHE_TTL_MS = 15_000;
const DEFAULT_FUNDING_TERMS_VERSION =
  String(process.env.NEXT_PUBLIC_KAI_FUNDING_TERMS_VERSION || "").trim() || "v1";

async function extractPlaidError(response: Response, fallback: string): Promise<string> {
  const raw = await response.text().catch(() => "");
  try {
    const payload = (raw ? JSON.parse(raw) : null) as
      | {
          detail?: string | Record<string, unknown> | null;
          message?: string | null;
          error?: string | null;
          details?: string | null;
        }
      | null;
    const detail =
      payload?.detail && typeof payload.detail === "object" && !Array.isArray(payload.detail)
        ? (payload.detail as Record<string, unknown>)
        : null;
    const detailPayload =
      detail?.payload && typeof detail.payload === "object" && !Array.isArray(detail.payload)
        ? (detail.payload as Record<string, unknown>)
        : null;
    const candidates = [
      typeof detail?.display_message === "string" ? detail.display_message : null,
      typeof detail?.message === "string" ? detail.message : null,
      typeof detailPayload?.error_message === "string" ? detailPayload.error_message : null,
      typeof payload?.message === "string" ? payload.message : null,
      typeof payload?.error === "string" ? payload.error : null,
      typeof payload?.details === "string" ? payload.details : null,
      typeof payload?.detail === "string" ? payload.detail : null,
      raw && !raw.trim().startsWith("<") ? raw : null,
    ];
    const message = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
    return message?.trim() || fallback;
  } catch {
    return raw && !raw.trim().startsWith("<") ? raw.trim() : fallback;
  }
}

export class PlaidPortfolioService {
  private static statusCache = new Map<
    string,
    { value: PlaidPortfolioStatusResponse; expiresAt: number }
  >();
  private static statusInflight = new Map<string, Promise<PlaidPortfolioStatusResponse>>();
  private static fundingStatusCache = new Map<
    string,
    { value: PlaidFundingStatusResponse; expiresAt: number }
  >();
  private static fundingStatusInflight = new Map<string, Promise<PlaidFundingStatusResponse>>();

  private static statusKey(userId: string): string {
    return String(userId || "").trim();
  }

  private static readStatusCache(key: string): PlaidPortfolioStatusResponse | null {
    const entry = this.statusCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.statusCache.delete(key);
      return null;
    }
    return entry.value;
  }

  private static readFundingStatusCache(key: string): PlaidFundingStatusResponse | null {
    const entry = this.fundingStatusCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.fundingStatusCache.delete(key);
      return null;
    }
    return entry.value;
  }

  static invalidateStatusCache(userId?: string): void {
    const key = String(userId || "").trim();
    if (key) {
      this.statusCache.delete(key);
      this.statusInflight.delete(key);
      this.fundingStatusCache.delete(key);
      this.fundingStatusInflight.delete(key);
      return;
    }
    this.statusCache.clear();
    this.statusInflight.clear();
    this.fundingStatusCache.clear();
    this.fundingStatusInflight.clear();
  }

  static async getStatus(params: {
    userId: string;
    vaultOwnerToken: string;
  }, options?: { force?: boolean }): Promise<PlaidPortfolioStatusResponse> {
    const key = this.statusKey(params.userId);
    if (!options?.force) {
      const cached = this.readStatusCache(key);
      if (cached) return cached;
      const inflight = this.statusInflight.get(key);
      if (inflight) return inflight;
    }

    const request = (async () => {
      const response = await ApiService.apiFetch(
        `/api/kai/plaid/status/${encodeURIComponent(params.userId)}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${params.vaultOwnerToken}`,
          },
        }
      );
      if (!response.ok) {
        throw new Error(`Failed to load Plaid portfolio status: ${response.status}`);
      }
      const payload = (await response.json()) as PlaidPortfolioStatusResponse;
      this.statusCache.set(key, {
        value: payload,
        expiresAt: Date.now() + PLAID_STATUS_CACHE_TTL_MS,
      });
      return payload;
    })().finally(() => {
      if (this.statusInflight.get(key) === request) {
        this.statusInflight.delete(key);
      }
    });

    this.statusInflight.set(key, request);
    return request;
  }

  static async createLinkToken(params: {
    userId: string;
    vaultOwnerToken: string;
    itemId?: string;
    updateMode?: boolean;
    redirectUri?: string;
  }): Promise<PlaidLinkTokenResponse> {
    const path = params.updateMode
      ? "/api/kai/plaid/link-token/update"
      : "/api/kai/plaid/link-token";
    const response = await ApiService.apiFetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.vaultOwnerToken}`,
      },
      body: JSON.stringify({
        user_id: params.userId,
        item_id: params.itemId,
        redirect_uri: params.redirectUri || null,
      }),
    });
    if (!response.ok) {
      const detail = await extractPlaidError(
        response,
        "Plaid could not start the connection flow right now."
      );
      throw new Error(detail);
    }
    return (await response.json()) as PlaidLinkTokenResponse;
  }

  static async exchangePublicToken(params: {
    userId: string;
    publicToken: string;
    vaultOwnerToken: string;
    metadata?: Record<string, unknown> | null;
    resumeSessionId?: string | null;
  }): Promise<PlaidPortfolioStatusResponse> {
    const response = await ApiService.apiFetch("/api/kai/plaid/exchange-public-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.vaultOwnerToken}`,
      },
      body: JSON.stringify({
        user_id: params.userId,
        public_token: params.publicToken,
        metadata: params.metadata || null,
        resume_session_id: params.resumeSessionId || null,
      }),
    });
    if (!response.ok) {
      const detail = await extractPlaidError(
        response,
        "Plaid could not finish connecting this brokerage."
      );
      throw new Error(detail);
    }
    const payload = (await response.json()) as PlaidPortfolioStatusResponse;
    this.invalidateStatusCache(params.userId);
    CacheSyncService.onPlaidSourceProjected(params.userId);
    return payload;
  }

  static async refresh(params: {
    userId: string;
    vaultOwnerToken: string;
    itemId?: string;
  }): Promise<PlaidRefreshResponse> {
    const response = await ApiService.apiFetch("/api/kai/plaid/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.vaultOwnerToken}`,
      },
      body: JSON.stringify({
        user_id: params.userId,
        item_id: params.itemId,
      }),
    });
    if (!response.ok) {
      const detail = await extractPlaidError(
        response,
        "Plaid could not refresh this brokerage right now."
      );
      throw new Error(detail);
    }
    this.invalidateStatusCache(params.userId);
    return (await response.json()) as PlaidRefreshResponse;
  }

  static async resumeOAuth(params: {
    userId: string;
    resumeSessionId: string;
    vaultOwnerToken: string;
  }): Promise<PlaidLinkTokenResponse> {
    const response = await ApiService.apiFetch("/api/kai/plaid/oauth/resume", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.vaultOwnerToken}`,
      },
      body: JSON.stringify({
        user_id: params.userId,
        resume_session_id: params.resumeSessionId,
      }),
    });
    if (!response.ok) {
      const detail = await extractPlaidError(
        response,
        "Plaid could not resume this brokerage connection."
      );
      throw new Error(detail);
    }
    return (await response.json()) as PlaidLinkTokenResponse;
  }

  static async getRefreshRun(params: {
    userId: string;
    runId: string;
    vaultOwnerToken: string;
  }): Promise<{ run: Record<string, unknown> }> {
    const query = new URLSearchParams({ user_id: params.userId }).toString();
    const response = await ApiService.apiFetch(
      `/api/kai/plaid/refresh/${encodeURIComponent(params.runId)}?${query}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${params.vaultOwnerToken}`,
        },
      }
    );
    if (!response.ok) {
      const detail = await extractPlaidError(
        response,
        "Plaid refresh status is not available right now."
      );
      throw new Error(detail);
    }
    return (await response.json()) as { run: Record<string, unknown> };
  }

  static async cancelRefreshRun(params: {
    userId: string;
    runId: string;
    vaultOwnerToken: string;
  }): Promise<{ run: Record<string, unknown> }> {
    const response = await ApiService.apiFetch(
      `/api/kai/plaid/refresh/${encodeURIComponent(params.runId)}/cancel`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.vaultOwnerToken}`,
        },
        body: JSON.stringify({
          user_id: params.userId,
        }),
      }
    );
    if (!response.ok) {
      const detail = await extractPlaidError(
        response,
        "Plaid could not cancel this refresh right now."
      );
      throw new Error(detail);
    }
    return (await response.json()) as { run: Record<string, unknown> };
  }

  static async setActiveSource(params: {
    userId: string;
    activeSource: PortfolioSource;
    vaultOwnerToken: string;
  }): Promise<{ user_id: string; active_source: PortfolioSource }> {
    const response = await ApiService.apiFetch("/api/kai/plaid/source", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.vaultOwnerToken}`,
      },
      body: JSON.stringify({
        user_id: params.userId,
        active_source: params.activeSource,
      }),
    });
    if (!response.ok) {
      const detail = await extractPlaidError(
        response,
        "Kai could not switch the portfolio source."
      );
      throw new Error(detail);
    }
    this.invalidateStatusCache(params.userId);
    return (await response.json()) as { user_id: string; active_source: PortfolioSource };
  }

  static async createFundingLinkToken(params: {
    userId: string;
    vaultOwnerToken: string;
    itemId?: string;
    redirectUri?: string;
  }): Promise<PlaidLinkTokenResponse> {
    const response = await ApiService.apiFetch("/api/kai/plaid/funding/link-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.vaultOwnerToken}`,
      },
      body: JSON.stringify({
        user_id: params.userId,
        item_id: params.itemId,
        redirect_uri: params.redirectUri || null,
      }),
    });
    if (!response.ok) {
      const detail = await extractPlaidError(
        response,
        "Plaid could not start the funding connection flow right now."
      );
      throw new Error(detail);
    }
    return (await response.json()) as PlaidLinkTokenResponse;
  }

  static async exchangeFundingPublicToken(params: {
    userId: string;
    publicToken: string;
    vaultOwnerToken: string;
    metadata?: Record<string, unknown> | null;
    resumeSessionId?: string | null;
    termsVersion?: string | null;
    consentTimestamp?: string | null;
    alpacaAccountId?: string | null;
  }): Promise<PlaidFundingStatusResponse> {
    const termsVersion = String(params.termsVersion || "").trim() || DEFAULT_FUNDING_TERMS_VERSION;
    const consentTimestamp =
      String(params.consentTimestamp || "").trim() || new Date().toISOString();
    const response = await ApiService.apiFetch("/api/kai/plaid/funding/exchange-public-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.vaultOwnerToken}`,
      },
      body: JSON.stringify({
        user_id: params.userId,
        public_token: params.publicToken,
        metadata: params.metadata || null,
        resume_session_id: params.resumeSessionId || null,
        terms_version: termsVersion,
        consent_timestamp: consentTimestamp,
        alpaca_account_id: params.alpacaAccountId || null,
      }),
    });
    if (!response.ok) {
      const detail = await extractPlaidError(
        response,
        "Plaid could not finish connecting this funding account."
      );
      throw new Error(detail);
    }
    this.invalidateStatusCache(params.userId);
    return (await response.json()) as PlaidFundingStatusResponse;
  }

  static async setDefaultFundingAccount(params: {
    userId: string;
    itemId: string;
    accountId: string;
    vaultOwnerToken: string;
  }): Promise<PlaidFundingStatusResponse> {
    const response = await ApiService.apiFetch("/api/kai/plaid/funding/default-account", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.vaultOwnerToken}`,
      },
      body: JSON.stringify({
        user_id: params.userId,
        item_id: params.itemId,
        account_id: params.accountId,
      }),
    });
    if (!response.ok) {
      const detail = await extractPlaidError(
        response,
        "The default funding account could not be updated right now."
      );
      throw new Error(detail);
    }
    this.invalidateStatusCache(params.userId);
    return (await response.json()) as PlaidFundingStatusResponse;
  }

  static async setFundingBrokerageAccount(params: {
    userId: string;
    alpacaAccountId?: string | null;
    vaultOwnerToken: string;
    setDefault?: boolean;
  }): Promise<PlaidFundingStatusResponse> {
    const payload: Record<string, unknown> = {
      user_id: params.userId,
      set_default: params.setDefault !== false,
    };
    const cleanedAccountId = String(params.alpacaAccountId || "").trim();
    if (cleanedAccountId) {
      payload.alpaca_account_id = cleanedAccountId;
    }
    const response = await ApiService.apiFetch("/api/kai/plaid/funding/brokerage-account", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.vaultOwnerToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const detail = await extractPlaidError(
        response,
        "The Alpaca brokerage account could not be linked right now."
      );
      throw new Error(detail);
    }
    this.invalidateStatusCache(params.userId);
    return (await response.json()) as PlaidFundingStatusResponse;
  }

  static async startAlpacaConnect(params: {
    userId: string;
    vaultOwnerToken: string;
    redirectUri?: string | null;
  }): Promise<AlpacaConnectStartResponse> {
    const response = await ApiService.apiFetch("/api/kai/alpaca/connect/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.vaultOwnerToken}`,
      },
      body: JSON.stringify({
        user_id: params.userId,
        redirect_uri: params.redirectUri || null,
      }),
    });
    if (!response.ok) {
      const detail = await extractPlaidError(
        response,
        "Alpaca login could not be started right now."
      );
      throw new Error(detail);
    }
    return (await response.json()) as AlpacaConnectStartResponse;
  }

  static async completeAlpacaConnect(params: {
    userId: string;
    vaultOwnerToken: string;
    state: string;
    code: string;
  }): Promise<PlaidFundingStatusResponse> {
    const response = await ApiService.apiFetch("/api/kai/alpaca/connect/complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.vaultOwnerToken}`,
      },
      body: JSON.stringify({
        user_id: params.userId,
        state: params.state,
        code: params.code,
      }),
    });
    if (!response.ok) {
      const detail = await extractPlaidError(
        response,
        "Alpaca login could not be completed right now."
      );
      throw new Error(detail);
    }
    this.invalidateStatusCache(params.userId);
    return (await response.json()) as PlaidFundingStatusResponse;
  }

  static async getFundingStatus(params: {
    userId: string;
    vaultOwnerToken: string;
  }, options?: { force?: boolean }): Promise<PlaidFundingStatusResponse> {
    const key = this.statusKey(params.userId);
    if (!options?.force) {
      const cached = this.readFundingStatusCache(key);
      if (cached) return cached;
      const inflight = this.fundingStatusInflight.get(key);
      if (inflight) return inflight;
    }

    const request = (async () => {
      const response = await ApiService.apiFetch(
        `/api/kai/plaid/funding/status/${encodeURIComponent(params.userId)}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${params.vaultOwnerToken}`,
          },
        }
      );
      if (!response.ok) {
        const detail = await extractPlaidError(
          response,
          "Plaid funding status is not available right now."
        );
        throw new Error(detail);
      }
      const payload = (await response.json()) as PlaidFundingStatusResponse;
      this.fundingStatusCache.set(key, {
        value: payload,
        expiresAt: Date.now() + PLAID_STATUS_CACHE_TTL_MS,
      });
      return payload;
    })().finally(() => {
      if (this.fundingStatusInflight.get(key) === request) {
        this.fundingStatusInflight.delete(key);
      }
    });

    this.fundingStatusInflight.set(key, request);
    return request;
  }

  static async syncFundingTransactions(params: {
    userId: string;
    itemId: string;
    vaultOwnerToken: string;
    cursor?: string | null;
  }): Promise<{
    item_id: string;
    next_cursor?: string | null;
    added: Array<Record<string, unknown>>;
    modified: Array<Record<string, unknown>>;
    removed: Array<Record<string, unknown>>;
    counts: { added: number; modified: number; removed: number };
  }> {
    const response = await ApiService.apiFetch("/api/kai/plaid/funding/transactions/sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.vaultOwnerToken}`,
      },
      body: JSON.stringify({
        user_id: params.userId,
        item_id: params.itemId,
        cursor: params.cursor || null,
      }),
    });
    if (!response.ok) {
      const detail = await extractPlaidError(
        response,
        "Funding transactions could not be synced right now."
      );
      throw new Error(detail);
    }
    return (await response.json()) as {
      item_id: string;
      next_cursor?: string | null;
      added: Array<Record<string, unknown>>;
      modified: Array<Record<string, unknown>>;
      removed: Array<Record<string, unknown>>;
      counts: { added: number; modified: number; removed: number };
    };
  }

  static async createTransfer(params: {
    userId: string;
    vaultOwnerToken: string;
    fundingItemId: string;
    fundingAccountId: string;
    amount: number;
    userLegalName: string;
    direction?: "to_brokerage" | "from_brokerage";
    network?: string;
    achClass?: string;
    description?: string;
    idempotencyKey?: string;
    brokerageItemId?: string | null;
    brokerageAccountId?: string | null;
    redirectUri?: string | null;
  }): Promise<PlaidTransferCreateResponse> {
    const response = await ApiService.apiFetch("/api/kai/plaid/transfers/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.vaultOwnerToken}`,
      },
      body: JSON.stringify({
        user_id: params.userId,
        funding_item_id: params.fundingItemId,
        funding_account_id: params.fundingAccountId,
        amount: params.amount,
        user_legal_name: params.userLegalName,
        direction: params.direction || "to_brokerage",
        network: params.network || "ach",
        ach_class: params.achClass || "web",
        description: params.description || null,
        idempotency_key: params.idempotencyKey || null,
        brokerage_item_id: params.brokerageItemId || null,
        brokerage_account_id: params.brokerageAccountId || null,
        redirect_uri: params.redirectUri || null,
      }),
    });
    if (!response.ok) {
      const detail = await extractPlaidError(response, "Transfer could not be created right now.");
      throw new Error(detail);
    }
    this.invalidateStatusCache(params.userId);
    return (await response.json()) as PlaidTransferCreateResponse;
  }

  static async getTransfer(params: {
    userId: string;
    transferId: string;
    vaultOwnerToken: string;
  }): Promise<{
    transfer: PlaidTransferPayload;
    reference?: Record<string, unknown>;
  }> {
    const query = new URLSearchParams({ user_id: params.userId }).toString();
    const response = await ApiService.apiFetch(
      `/api/kai/plaid/transfers/${encodeURIComponent(params.transferId)}?${query}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${params.vaultOwnerToken}`,
        },
      }
    );
    if (!response.ok) {
      const detail = await extractPlaidError(response, "Transfer status is not available right now.");
      throw new Error(detail);
    }
    return (await response.json()) as {
      transfer: PlaidTransferPayload;
      reference?: Record<string, unknown>;
    };
  }

  static async cancelTransfer(params: {
    userId: string;
    transferId: string;
    vaultOwnerToken: string;
  }): Promise<{
    transfer: PlaidTransferPayload;
    reference?: Record<string, unknown>;
    canceled?: boolean;
  }> {
    const response = await ApiService.apiFetch(
      `/api/kai/plaid/transfers/${encodeURIComponent(params.transferId)}/cancel`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.vaultOwnerToken}`,
        },
        body: JSON.stringify({
          user_id: params.userId,
        }),
      }
    );
    if (!response.ok) {
      const detail = await extractPlaidError(response, "Transfer could not be canceled right now.");
      throw new Error(detail);
    }
    this.invalidateStatusCache(params.userId);
    return (await response.json()) as {
      transfer: PlaidTransferPayload;
      reference?: Record<string, unknown>;
      canceled?: boolean;
    };
  }

  static async refreshFundingTransferStatus(params: {
    userId: string;
    transferId: string;
    vaultOwnerToken: string;
  }): Promise<{
    transfer: PlaidTransferPayload;
    reference?: Record<string, unknown>;
  }> {
    const response = await ApiService.apiFetch(
      `/api/kai/plaid/funding/admin/transfers/${encodeURIComponent(params.transferId)}/refresh`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.vaultOwnerToken}`,
        },
        body: JSON.stringify({
          user_id: params.userId,
        }),
      }
    );
    if (!response.ok) {
      const detail = await extractPlaidError(
        response,
        "Transfer status could not be refreshed right now."
      );
      throw new Error(detail);
    }
    this.invalidateStatusCache(params.userId);
    return (await response.json()) as {
      transfer: PlaidTransferPayload;
      reference?: Record<string, unknown>;
    };
  }

  static async runFundingReconciliation(params: {
    userId: string;
    vaultOwnerToken: string;
    maxRows?: number;
    triggerSource?: string;
  }): Promise<Record<string, unknown>> {
    const response = await ApiService.apiFetch("/api/kai/plaid/funding/reconcile", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.vaultOwnerToken}`,
      },
      body: JSON.stringify({
        user_id: params.userId,
        max_rows: params.maxRows ?? 200,
        trigger_source: params.triggerSource || "manual_ui",
      }),
    });
    if (!response.ok) {
      const detail = await extractPlaidError(
        response,
        "Funding reconciliation could not be started right now."
      );
      throw new Error(detail);
    }
    this.invalidateStatusCache(params.userId);
    return (await response.json()) as Record<string, unknown>;
  }

  static async searchFundingRecords(params: {
    userId: string;
    vaultOwnerToken: string;
    transferId?: string | null;
    relationshipId?: string | null;
    limit?: number;
  }): Promise<PlaidFundingAdminSearchResponse> {
    const query = new URLSearchParams({
      user_id: params.userId,
      ...(params.transferId ? { transfer_id: params.transferId } : {}),
      ...(params.relationshipId ? { relationship_id: params.relationshipId } : {}),
      ...(typeof params.limit === "number" ? { limit: String(params.limit) } : {}),
    }).toString();

    const response = await ApiService.apiFetch(`/api/kai/plaid/funding/admin/search?${query}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.vaultOwnerToken}`,
      },
    });
    if (!response.ok) {
      const detail = await extractPlaidError(
        response,
        "Funding support records are not available right now."
      );
      throw new Error(detail);
    }
    return (await response.json()) as PlaidFundingAdminSearchResponse;
  }

  static async createFundingEscalation(params: {
    userId: string;
    vaultOwnerToken: string;
    transferId?: string | null;
    relationshipId?: string | null;
    notes: string;
    severity?: "low" | "normal" | "high" | "urgent";
    createdBy?: string | null;
  }): Promise<Record<string, unknown>> {
    const response = await ApiService.apiFetch("/api/kai/plaid/funding/admin/escalations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.vaultOwnerToken}`,
      },
      body: JSON.stringify({
        user_id: params.userId,
        transfer_id: params.transferId || null,
        relationship_id: params.relationshipId || null,
        notes: params.notes,
        severity: params.severity || "normal",
        created_by: params.createdBy || null,
      }),
    });
    if (!response.ok) {
      const detail = await extractPlaidError(
        response,
        "Funding escalation could not be created right now."
      );
      throw new Error(detail);
    }
    return (await response.json()) as Record<string, unknown>;
  }
}
