# Indian Stock Market Support

> **Issue #485** · Phase 1 shipped on `feat/indian-market-485`

---

## Overview

Hushh and Kai now support Indian stock market workflows for NSE and BSE equities, indices, and broker portfolio imports.

**Market data works immediately with zero credentials.** Broker-specific features (portfolio import, order routing) require maintainers to inject API keys via environment variables.

---

## What Ships in Phase 1

| Feature | Status | Notes |
|---|---|---|
| NSE/BSE equity quotes | ✅ Live | yfinance, `.NS`/`.BO` suffixes |
| Nifty 50 / Sensex / Bank Nifty | ✅ Live | yfinance index symbols |
| Symbol search | ✅ Live | bundled static list, ~80 top symbols |
| Voice intent detection | ✅ Live | local pattern + spoken-alias resolution |
| INR formatting (lakh/crore) | ✅ Live | `formatINR`, `formatINRCompact` |
| Exchange badges (NSE/BSE) | ✅ Live | `ExchangeBadge` component |
| Index bar component | ✅ Live | `IndianIndexBar`, auto-refreshes every 60 s |
| Quote card component | ✅ Live | `IndianQuoteCard`, compact + full modes |
| Zerodha Kite adapter | ✅ Skeleton | requires `ZERODHA_API_KEY` + `ZERODHA_ACCESS_TOKEN` |
| Upstox V2 adapter | ✅ Skeleton | requires `UPSTOX_API_KEY` + `UPSTOX_ACCESS_TOKEN` |

---

## Architecture

```
Voice Utterance
    └─► voice_intent_service.py   (COMMAND_ALIASES: nifty/sensex/nse → "indian_market")
            └─► API: /kai/indian-market/quote/{symbol}
                        └─► indian_market_service.py
                                ├─ L1: in-process cache (60 s)
                                ├─ L2: MarketCacheStore / Postgres (15 min)
                                └─ L3: yfinance HTTP → Yahoo Finance
                                        (fallback: ZerodhaKiteAdapter / UpstoxAdapter)
```

---

## Symbol Format

| Exchange | Format | Example |
|---|---|---|
| NSE | `{TICKER}.NS` | `RELIANCE.NS` |
| BSE | `{TICKER}.BO` | `RELIANCE.BO` |
| Nifty 50 | `^NSEI` | `^NSEI` |
| Sensex | `^BSESN` | `^BSESN` |
| Bank Nifty | `^NSEBANK` | `^NSEBANK` |

Bare symbols (e.g. `RELIANCE`) are auto-resolved to `RELIANCE.NS` unless `INDIAN_MARKET_DEFAULT_EXCHANGE=BSE`.

---

## API Endpoints

All endpoints are under `/api/kai/indian-market`:

```
GET /status                  Configuration status (zerodha, upstox, data_provider)
GET /indices                 Nifty 50 + Sensex + Bank Nifty snapshot
GET /quote/{symbol}          Single equity quote — e.g. RELIANCE, RELIANCE.NS, "hdfc bank"
GET /search?q={query}        NSE/BSE symbol search
GET /portfolio?broker=...    Broker holdings (requires credentials)
```

---

## Environment Variables

Add to your `.env` (or deployment secrets):

```bash
# ── Indian Market Feature ─────────────────────────────────────────────────
# Default: enabled with NSE as primary exchange. No keys needed for quotes.
INDIAN_MARKET_ENABLED=true
INDIAN_MARKET_DEFAULT_EXCHANGE=NSE   # NSE or BSE

# ── Zerodha Kite Connect ─────────────────────────────────────────────────
# Get from: https://kite.zerodha.com/ → Developer API
ZERODHA_API_KEY=                     # Required for live portfolio/orders
ZERODHA_API_SECRET=                  # Required for OAuth login flow
ZERODHA_ACCESS_TOKEN=                # Session token (expires daily; refresh via login flow)

# ── Upstox V2 ────────────────────────────────────────────────────────────
# Get from: https://upstox.com/developer/api-documentation/
UPSTOX_API_KEY=
UPSTOX_ACCESS_TOKEN=                 # OAuth access token
```

> If broker credentials are absent, endpoints return HTTP 401 with a clear `detail` message. yfinance quotes remain fully functional.

---

## Voice Examples

Say to Kai:

| Utterance | What happens |
|---|---|
| "Show me Nifty" | Fetches `^NSEI`, returns Nifty 50 quote |
| "How is Sensex today" | Routes to `indian_market`, returns Sensex |
| "Analyze Reliance" | Spoken alias resolves to `RELIANCE.NS` |
| "What is the price of HDFC Bank" | Resolves to `HDFCBANK.NS` |
| "TCS.NS quote" | `.NS` suffix detected, direct lookup |

---

## Frontend Components

### `IndianIndexBar`
```tsx
import { IndianIndexBar } from '@/components/indian-market/IndianIndexBar';

<IndianIndexBar className="mb-4" />
```
Auto-refreshes every 60 seconds. Renders nothing if the API is unreachable (fail-silent).

### `IndianQuoteCard`
```tsx
import { IndianQuoteCard } from '@/components/indian-market/IndianQuoteCard';

const quote = await getIndianQuote('RELIANCE.NS');
<IndianQuoteCard quote={quote} />
<IndianQuoteCard quote={quote} compact />
```

### `ExchangeBadge`
```tsx
import { ExchangeBadge } from '@/components/indian-market/ExchangeBadge';

<ExchangeBadge exchange="NSE" />   {/* blue  */}
<ExchangeBadge exchange="BSE" />   {/* orange */}
```

---

## Phased Roadmap

| Phase | Status | Description |
|---|---|---|
| 1 — Foundation | ✅ **Shipped** | yfinance quotes, indices, symbol search, voice routing, UI components, broker skeletons |
| 2 — Broker Portfolio | 🔜 Pending keys | Full Zerodha/Upstox portfolio import, holdings sync, P&L display |
| 3 — Order Execution | 🔜 Future | Buy/sell order routing via Kite/Upstox API with consent gate |

---

## Regulatory Note

Indian equity market data is sourced from Yahoo Finance (yfinance) for Phase 1. This data is:
- **Delayed** (~15 minutes for free-tier Yahoo Finance)
- **Not suitable** for real-time trading decisions without a live broker feed

For production order execution, maintainers must integrate a SEBI-registered data vendor or use the broker's own live feed (Kite WebSocket / Upstox WebSocket). These integration points are pre-wired in the adapter skeletons.

---

## Running the Tests

```bash
# Backend
cd consent-protocol
python -m pytest tests/test_indian_market_service.py -v

# Frontend
cd hushh-webapp
npx vitest run __tests__/services/indian-market-service.test.ts

# Frontend typecheck
npm run typecheck
```
