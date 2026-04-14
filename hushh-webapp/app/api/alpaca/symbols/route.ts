import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parse as parseEnv } from "dotenv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const ASSET_UNIVERSE_TTL_MS = 1000 * 60 * 5;

type AlpacaAssetMeta = {
  id: string | null;
  symbol: string;
  name: string | null;
  exchange: string | null;
  assetClass: string | null;
  status: string | null;
  tradable: boolean | null;
  marginable: boolean | null;
  shortable: boolean | null;
  easyToBorrow: boolean | null;
  fractionable: boolean | null;
  maintenanceMarginRequirement: number | null;
  attributes: string[];
};

type CachedAssetUniverse = {
  fetchedAt: number;
  items: AlpacaAssetMeta[];
};

let localBackendEnvCache: Record<string, string> | null = null;
let assetUniverseCache: CachedAssetUniverse | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function clampLimit(rawValue: string | null): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(parsed)));
}

function getLocalBackendEnv(): Record<string, string> {
  if (localBackendEnvCache) return localBackendEnvCache;

  try {
    const envPath = resolvePath(process.cwd(), "..", "consent-protocol", ".env");
    if (!existsSync(envPath)) {
      localBackendEnvCache = {};
      return localBackendEnvCache;
    }
    localBackendEnvCache = parseEnv(readFileSync(envPath, "utf8"));
    return localBackendEnvCache;
  } catch {
    localBackendEnvCache = {};
    return localBackendEnvCache;
  }
}

function getAuthHeaders(): Record<string, string> | null {
  const localEnv = getLocalBackendEnv();
  const apiKey =
    process.env.ALPACA_API_KEY ||
    process.env.ALPACA_BROKER_KEY_ID ||
    process.env.APCA_API_KEY_ID ||
    localEnv.ALPACA_API_KEY ||
    localEnv.ALPACA_BROKER_KEY_ID ||
    localEnv.APCA_API_KEY_ID ||
    "";
  const apiSecret =
    process.env.ALPACA_API_SECRET ||
    process.env.ALPACA_BROKER_SECRET ||
    process.env.APCA_API_SECRET_KEY ||
    localEnv.ALPACA_API_SECRET ||
    localEnv.ALPACA_BROKER_SECRET ||
    localEnv.APCA_API_SECRET_KEY ||
    "";
  const bearer =
    process.env.ALPACA_BROKER_AUTH_TOKEN ||
    process.env.BROKER_TOKEN ||
    localEnv.ALPACA_BROKER_AUTH_TOKEN ||
    localEnv.BROKER_TOKEN ||
    "";

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
    return headers;
  }

  if (apiKey && apiSecret) {
    headers["APCA-API-KEY-ID"] = apiKey;
    headers["APCA-API-SECRET-KEY"] = apiSecret;
    return headers;
  }

  return null;
}

function normalizeAssetMeta(row: unknown): AlpacaAssetMeta | null {
  const data = asRecord(row);
  if (!data) return null;

  const symbol = readString(data.symbol);
  if (!symbol) return null;

  const attributesRaw = Array.isArray(data.attributes) ? data.attributes : [];
  const attributes = attributesRaw
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));

  return {
    id: readString(data.id),
    symbol: symbol.toUpperCase(),
    name: readString(data.name),
    exchange: readString(data.exchange),
    assetClass: readString(data.class) || readString(data.asset_class),
    status: readString(data.status),
    tradable: readBoolean(data.tradable),
    marginable: readBoolean(data.marginable),
    shortable: readBoolean(data.shortable),
    easyToBorrow: readBoolean(data.easy_to_borrow),
    fractionable: readBoolean(data.fractionable),
    maintenanceMarginRequirement: readNumber(data.maintenance_margin_requirement),
    attributes,
  };
}

function normalizeBar(row: unknown) {
  const data = asRecord(row);
  if (!data) return null;
  return {
    open: readNumber(data.o ?? data.open),
    high: readNumber(data.h ?? data.high),
    low: readNumber(data.l ?? data.low),
    close: readNumber(data.c ?? data.close),
    volume: readNumber(data.v ?? data.volume),
    vwap: readNumber(data.vw ?? data.vwap),
    tradeCount: readNumber(data.n ?? data.trade_count),
    timestamp: readString(data.t ?? data.timestamp),
  };
}

function normalizeTrade(row: unknown) {
  const data = asRecord(row);
  if (!data) return null;
  const conditionsRaw = Array.isArray(data.c) ? data.c : [];
  const conditions = conditionsRaw
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));

  return {
    price: readNumber(data.p ?? data.price),
    size: readNumber(data.s ?? data.size),
    exchange: readString(data.x ?? data.exchange),
    tape: readString(data.z ?? data.tape),
    timestamp: readString(data.t ?? data.timestamp),
    conditions,
  };
}

function normalizeQuote(row: unknown) {
  const data = asRecord(row);
  if (!data) return null;
  return {
    bidPrice: readNumber(data.bp ?? data.bid_price),
    bidSize: readNumber(data.bs ?? data.bid_size),
    bidExchange: readString(data.bx ?? data.bid_exchange),
    askPrice: readNumber(data.ap ?? data.ask_price),
    askSize: readNumber(data.as ?? data.ask_size),
    askExchange: readString(data.ax ?? data.ask_exchange),
    timestamp: readString(data.t ?? data.timestamp),
  };
}

function normalizeSnapshot(row: unknown) {
  const data = asRecord(row);
  if (!data) return null;

  return {
    latestTrade: normalizeTrade(data.latestTrade ?? data.latest_trade),
    latestQuote: normalizeQuote(data.latestQuote ?? data.latest_quote),
    minuteBar: normalizeBar(data.minuteBar ?? data.minute_bar),
    dailyBar: normalizeBar(data.dailyBar ?? data.daily_bar),
    prevDailyBar: normalizeBar(data.prevDailyBar ?? data.prev_daily_bar),
  };
}

function getSnapshotRows(payload: unknown): Record<string, unknown> {
  const data = asRecord(payload);
  if (!data) return {};
  const nested = asRecord(data.snapshots);
  return nested || data;
}

function rankAssetForQuery(asset: AlpacaAssetMeta, query: string): number {
  const symbol = asset.symbol.toUpperCase();
  const name = String(asset.name || "").toUpperCase();
  if (symbol === query) return 0;
  if (symbol.startsWith(query)) return 1;
  if (name.startsWith(query)) return 2;
  if (symbol.includes(query)) return 3;
  if (name.includes(query)) return 4;
  return 10;
}

async function fetchAssetUniverse(
  headers: Record<string, string>,
  tradingBaseUrl: string
): Promise<AlpacaAssetMeta[]> {
  const attempted = new Set<string>();
  const candidates = [
    `${tradingBaseUrl}/v2/assets?status=active&asset_class=us_equity`,
    `${tradingBaseUrl}/v1/assets?status=active&asset_class=us_equity`,
    "https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity",
    "https://api.alpaca.markets/v2/assets?status=active&asset_class=us_equity",
  ].filter((url) => {
    if (attempted.has(url)) return false;
    attempted.add(url);
    return true;
  });

  const errors: string[] = [];
  for (const endpoint of candidates) {
    try {
      const response = await fetch(endpoint, { headers, cache: "no-store" });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        errors.push(`${endpoint} -> ${response.status} ${detail}`.trim());
        continue;
      }

      const payload = (await response.json().catch(() => null)) as unknown;
      if (!Array.isArray(payload)) {
        errors.push(`${endpoint} -> expected array payload`);
        continue;
      }

      const normalized = payload
        .map(normalizeAssetMeta)
        .filter((row): row is AlpacaAssetMeta => row !== null);
      if (normalized.length) {
        return normalized;
      }

      errors.push(`${endpoint} -> empty asset list`);
    } catch (error) {
      errors.push(
        `${endpoint} -> ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  throw new Error(errors.join(" | "));
}

async function getAssetUniverseCached(
  headers: Record<string, string>,
  tradingBaseUrl: string
): Promise<AlpacaAssetMeta[]> {
  if (
    assetUniverseCache &&
    Date.now() - assetUniverseCache.fetchedAt < ASSET_UNIVERSE_TTL_MS
  ) {
    return assetUniverseCache.items;
  }

  const items = await fetchAssetUniverse(headers, tradingBaseUrl);
  assetUniverseCache = {
    fetchedAt: Date.now(),
    items,
  };
  return items;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim().toUpperCase();
  const limit = clampLimit(url.searchParams.get("limit"));
  if (!q) {
    return NextResponse.json(
      { query: "", itemCount: 0, items: [] },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const headers = getAuthHeaders();
  if (!headers) {
    return NextResponse.json(
      {
        error:
          "Alpaca credentials are missing. Set ALPACA_API_KEY + ALPACA_API_SECRET or ALPACA_BROKER_AUTH_TOKEN.",
      },
      { status: 500 }
    );
  }

  const localEnv = getLocalBackendEnv();
  const dataBaseUrl = String(
    process.env.ALPACA_DATA_BASE_URL ||
      localEnv.ALPACA_DATA_BASE_URL ||
      "https://data.alpaca.markets"
  ).replace(/\/+$/, "");
  const tradingBaseUrl = String(
    process.env.ALPACA_TRADING_BASE_URL ||
      process.env.ALPACA_API_BASE_URL ||
      process.env.ALPACA_BROKER_BASE_URL ||
      localEnv.ALPACA_TRADING_BASE_URL ||
      localEnv.ALPACA_API_BASE_URL ||
      localEnv.ALPACA_BROKER_BASE_URL ||
      "https://paper-api.alpaca.markets"
  ).replace(/\/+$/, "");

  try {
    const assetUniverse = await getAssetUniverseCached(headers, tradingBaseUrl);
    const matches = assetUniverse
      .filter((asset) => rankAssetForQuery(asset, q) < 10)
      .sort((a, b) => {
        const rankDiff = rankAssetForQuery(a, q) - rankAssetForQuery(b, q);
        if (rankDiff !== 0) return rankDiff;
        return a.symbol.localeCompare(b.symbol);
      })
      .slice(0, limit);

    const symbols = matches.map((asset) => asset.symbol);
    let snapshotRows: Record<string, unknown> = {};
    if (symbols.length) {
      const snapshotsUrl =
        `${dataBaseUrl}/v2/stocks/snapshots?symbols=` +
        encodeURIComponent(symbols.join(","));
      const snapshotsResponse = await fetch(snapshotsUrl, {
        headers,
        cache: "no-store",
      });
      if (snapshotsResponse.ok) {
        const snapshotPayload = (await snapshotsResponse
          .json()
          .catch(() => null)) as unknown;
        snapshotRows = getSnapshotRows(snapshotPayload);
      }
    }

    const items = matches.map((asset) => {
      const snapshot = normalizeSnapshot(
        snapshotRows[asset.symbol] || snapshotRows[asset.symbol.toUpperCase()]
      );
      const active = asset.status ? asset.status.toLowerCase() === "active" : null;

      return {
        symbol: asset.symbol,
        name: asset.name,
        exchange: asset.exchange,
        assetClass: asset.assetClass,
        status: asset.status,
        active,
        tradable: asset.tradable,
        marginable: asset.marginable,
        shortable: asset.shortable,
        easyToBorrow: asset.easyToBorrow,
        fractionable: asset.fractionable,
        maintenanceMarginRequirement: asset.maintenanceMarginRequirement,
        attributes: asset.attributes,
        currency: "USD",
        market: snapshot,
        reference: {
          symbol: asset.symbol,
          name: asset.name,
          exchange: asset.exchange,
          assetClass: asset.assetClass,
          status: asset.status,
          active,
        },
        asset,
      };
    });

    return NextResponse.json(
      { query: q, itemCount: items.length, items },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: "Alpaca stock lookup failed.",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
