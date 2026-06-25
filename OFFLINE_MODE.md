# Hussh Air-Gapped Offline Mode

## Overview

This is a **truly air-gapped** offline development mode for the Hussh platform. It requires **zero internet connectivity** and operates entirely with local services.

## What's Disabled

| Service | Status | Fallback |
|---------|--------|----------|
| PostgreSQL (Cloud SQL/Supabase) | ❌ Disabled | SQLite (local file) |
| Firebase Auth | ❌ Disabled | Local token (`?local=1`) |
| Gemini AI (Vertex AI) | ❌ Disabled | Mock responses |
| Gmail API | ❌ Disabled | Mock responses |
| Redis | ❌ Disabled | In-memory |
| GCP Secrets Manager | ❌ Disabled | `.env` file |

## Quick Start

### 1. Bootstrap Offline Environment

```bash
./scripts/env/bootstrap_offline.sh
```

This will:
- Initialize SQLite database with offline schema (`consent-protocol/tmp/hushh-offline.db`)
- Copy `.env.local.offline` template to `.env.local`

### 2. Start Backend

```bash
./bin/hushh backend --mode offline
```

Or directly:

```bash
./scripts/runtime/run_backend_offline.sh
```

The backend will start on `http://127.0.0.1:8000` with:
- SQLite database (no PostgreSQL needed)
- Review mode login via `POST /api/app-config/review-mode/session?local=1`
- Mock AI/email responses

### 3. Start Frontend

Set `DB_OFFLINE=1` in your frontend env and run:

```bash
./bin/hushh web --mode offline
```

## Architecture

### Database Layer

- **Schema**: `consent-protocol/db/offline_schema.sql` — SQLite DDL mirroring the
  real Postgres consent/PKM/vault/developer tables (auto-generated from the live
  schema by `db/_gen_offline_schema.py`; regenerate when migrations change those
  columns).
- **Storage**: SQLite with WAL journal mode
- **Path**: `consent-protocol/tmp/hushh-offline.db` (override with `OFFLINE_DB_PATH`)
- **Activation**: `DB_OFFLINE=1` env var

There are **two** database access layers in the backend, and offline mode wires
up both:

1. **`db/db_client.py` (SQLAlchemy)** — the primary path used by the consent
   connector, PKM, vault, and developer-registry services (`get_db()`).
   In offline mode `get_db_engine()` builds a **SQLite SQLAlchemy engine** and
   auto-applies `offline_schema.sql` on first use. The Supabase-compatible
   `TableQuery` builder already emits portable SQL (`:param` placeholders,
   `ON CONFLICT … DO UPDATE … RETURNING`), all of which SQLite ≥ 3.35 supports.
   JSON columns are stored as TEXT (`_adapt_db_params` json-encodes dict values
   for non-Postgres dialects).

2. **`db/connection.py` (asyncpg)** — used by a handful of peripheral services
   (market cache, gmail receipts, ria_iam, actor identity, marketplace
   replenisher). In offline mode `get_pool()` returns an asyncpg-compatible
   SQLite adapter (`db/offline_db.py`) exposing `acquire()`, `fetch`,
   `fetchrow`, `fetchval`, `execute`, with `$1`→`?` placeholder translation.

> **Parity caveat:** the SQLAlchemy path (consent/PKM/vault) has strong parity.
> The asyncpg adapter covers simple CRUD/cache queries only — Postgres-specific
> SQL (jsonb operators, `ANY($1)`, `INTERVAL`, advisory locks like
> `pg_try_advisory_lock`) is **not** translated and those peripheral features
> degrade gracefully (logged warnings, no crash).

### Auth Bypass

The reviewer session endpoint (`POST /api/app-config/review-mode/session`) accepts `?local=1` query param:

```bash
curl -X POST "http://127.0.0.1:8000/api/app-config/review-mode/session?local=1" \
  -H "Content-Type: application/json" \
  -d '{"subject": "reviewer"}'
```

Returns:
```json
{
  "token": "offline-local-token",
  "offline": true,
  "reviewer_uid": "UWHGeUyfUAbmEl5xwIPoWJ7Cyft2"
}
```

### Environment Variables

See `consent-protocol/.env.local.offline` for all offline-compatible env vars.

Key variables:
- `DB_OFFLINE=1` — Activates SQLite mode
- `OFFLINE_DB_PATH` — SQLite database file path
- `GEMINI_API_KEY=` — Leave empty for mock AI responses
- `GMAIL_API_KEY=` — Leave empty for mock email responses
- `APP_REVIEW_MODE=1` — Enable reviewer login
- `REVIEWER_UID` — Fixed reviewer UID
- `REVIEWER_VAULT_PASSPHRASE` — Vault passphrase for reviewer

## Database Schema

The offline schema (`db/offline_schema.sql`) mirrors the real Postgres tables on
the consent-connector / PKM / vault / developer-registry path. Current tables:

**Consent + export:** `consent_audit`, `consent_exports`,
`consent_export_refresh_jobs`, `internal_access_events`

**PKM:** `pkm_blobs`, `pkm_data`, `pkm_index`, `pkm_manifests`,
`pkm_manifest_paths`, `pkm_events`, `pkm_scope_registry`,
`pkm_default_available_projections`, `pkm_migration_state`

**Vault + runtime:** `vault_keys`, `vault_key_wrappers`, `user_push_tokens`,
`runtime_persona_state`

**Developer registry:** `developer_applications`, `developer_apps`,
`developer_tokens`

Regenerate from the live Postgres schema (proxy on `127.0.0.1:6543`) with:

```bash
PYTHONPATH=consent-protocol python consent-protocol/db/_gen_offline_schema.py \
  > consent-protocol/db/offline_schema.sql
```

**Not included**: RIA/scraping, marketplace, email/KYC, location tables.

## Limitations

- Column types are mapped to SQLite affinities; JSONB is stored as TEXT
  (json-encoded). No Postgres triggers, stored procedures, or RPC functions.
- Peripheral asyncpg call sites that use Postgres-only SQL (advisory locks,
  jsonb operators, `INTERVAL`, `ANY($1)`) degrade gracefully but are not
  fully functional offline.
- AI (Gemini) and Gmail use mock responses unless real API keys are provided.
  Note: some background market-data fetchers may still reach the network if
  their provider keys are present in the environment; unset them for a strict
  air-gap.
- No Firebase Auth (local `?local=1` bypass only).

## Troubleshooting

### SQLite not initialized

```bash
./scripts/env/bootstrap_offline.sh
```

### Missing virtualenv

```bash
cd consent-protocol
python3 -m venv .venv
pip install -r requirements.txt
```

### Port 8000 in use

```bash
lsof -i :8000  # Find the process
kill <PID>      # Stop it
```

### SQLite schema errors

Verify schema file exists:
```bash
ls -la consent-protocol/db/offline_schema.sql
```

## Future Enhancements

- [ ] Real Gemini API integration (set `GEMINI_API_KEY`)
- [ ] Real Gmail integration (set `GMAIL_API_KEY`)
- [ ] Pre-baked Docker images for offline use
- [ ] More comprehensive mock services
- [ ] Frontend offline mode support
- [ ] Additional SQLite tables (RIA, marketplace, etc.)
