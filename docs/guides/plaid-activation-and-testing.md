# Plaid Activation and Testing


## Visual Context

Canonical visual owner: [Guides Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Runbook for enabling Kai’s read-only Plaid brokerage connectivity on localhost, UAT, and hosted domains.

## What This Enables

- brokerage Link connect
- OAuth resume on web
- holdings sync
- investment transaction sync
- manual refresh
- webhook-driven updates
- read-only Plaid source in dashboard, debate context, and optimize context

It does not enable live trading.

## Required Allowlisted Redirect URIs

Register the full callback path in Plaid Dashboard:

- `http://localhost:3000/kai/plaid/oauth/return`
- `https://uat.kai.hushh.ai/kai/plaid/oauth/return`
- `https://kai.hushh.ai/kai/plaid/oauth/return`

Plaid requires the full absolute URI, not just the domain.

Webhook URLs do not need dashboard allowlisting. They are supplied by the backend during Link token creation and must be publicly reachable.

## Backend Env

Set these in the backend runtime profile:

- `PLAID_ENV=sandbox`
- `PLAID_CLIENT_ID=...`
- `PLAID_SECRET=...`
- `PLAID_CLIENT_NAME=Hushh Kai`
- `PLAID_COUNTRY_CODES=US`
- `PLAID_REDIRECT_PATH=/kai/plaid/oauth/return`
- `PLAID_WEBHOOK_URL=https://<public-domain-or-tunnel>/api/kai/plaid/webhook`
- `PLAID_TOKEN_ENCRYPTION_KEY=<recommended but optional>`
- `PLAID_TX_HISTORY_DAYS=730`

`FRONTEND_URL` must match the active frontend origin for the current profile.

Webhook values to use:

- local active stack: `https://<your-current-tunnel>/api/kai/plaid/webhook`
- UAT: `https://uat.kai.hushh.ai/api/kai/plaid/webhook`
- production: `https://kai.hushh.ai/api/kai/plaid/webhook`

`PLAID_WEBHOOK_URL` is the exact value that must be added to the backend env. It is not relative, and it is not allowlisted in the Plaid dashboard.

## Localhost

Use:

- frontend: `http://localhost:3000`
- backend runtime file: `consent-protocol/.env`
- webhook tunnel: ngrok or Cloudflare tunnel

Example webhook target:

- `https://<your-tunnel>/api/kai/plaid/webhook`

## Hosted

Use:

- UAT: `https://uat.kai.hushh.ai`
- Prod-like: `https://kai.hushh.ai`

Hosted webhook targets:

- `https://uat.kai.hushh.ai/api/kai/plaid/webhook`
- `https://kai.hushh.ai/api/kai/plaid/webhook`

Backend must use the matching `FRONTEND_URL` for each profile so the callback origin validation succeeds.

## Activation Steps

1. Apply `consent-protocol/db/migrations/023_kai_plaid_portfolio.sql`.
2. Set `PLAID_WEBHOOK_URL` for the active backend:
   - localhost/local: your current tunnel URL ending in `/api/kai/plaid/webhook`
   - UAT: `https://uat.kai.hushh.ai/api/kai/plaid/webhook`
3. Set a stable `PLAID_TOKEN_ENCRYPTION_KEY`.
4. Restart the backend so the new Plaid env values load.
5. Start the frontend on the matching origin.
6. Open Kai import or dashboard.
7. Click `Connect Plaid`.
8. Complete Link.
9. For OAuth institutions, confirm you return to `/kai/plaid/oauth/return` and then back into Kai.
10. If you changed webhook targets after Items already existed, do a one-time operator update for existing Items using Plaid's `/item/webhook/update`.

BYOK note:

- the callback flow re-issues a fresh `VAULT_OWNER` token
- it does not persist the vault key
- if your web session fully reloads during OAuth, Kai may still ask you to unlock the vault again before showing the full dashboard

## Expected Runtime Behavior

- `Statement` stays editable
- `Plaid` is read-only
- `Combined` is comparison-only
- transaction activity appears in the dashboard when broker activity exists
- refresh creates a background task and transitions to fresh data after webhook or fallback completion

## Core Tests

### Smoke

- connect one investment institution
- confirm holdings appear under `Plaid`
- confirm edit controls are hidden

### Multiple accounts under one Item

- connect a sandbox institution with more than one investment account
- confirm aggregation without overwrite

### Multiple institutions

- connect a second institution
- confirm `item_count` and `account_count` increase
- confirm dashboard lists both brokerages

### OAuth

- use an OAuth institution
- confirm redirect to the bank and back to `/kai/plaid/oauth/return`
- confirm the public token exchange completes

### Refresh

- click `Refresh`
- confirm a background task is created
- confirm status moves from `queued/running` to `completed`

### Source rules

- `Statement`: editable
- `Plaid`: read-only
- `Combined`: cannot launch Debate or Optimize directly

## Edge Cases To Validate

- missing `cost_basis`
- stale or missing `institution_price_as_of`
- `ITEM: NEW_ACCOUNTS_AVAILABLE`
- `ITEM: PENDING_EXPIRATION`
- `ITEM: USER_PERMISSION_REVOKED`
- duplicate institution relink attempt
- reconnect/update-mode success

## Verification Commands

- `python3 -m py_compile consent-protocol/hushh_mcp/services/plaid_portfolio_service.py consent-protocol/api/routes/kai/plaid.py consent-protocol/api/routes/kai/__init__.py`
- `cd hushh-webapp && npm run typecheck`
- manual runtime smoke for `/kai/import` and `/kai/portfolio`

## Capability Reminder

Plaid is only the read-only brokerage ingestion layer. Future trade execution must use broker-specific APIs behind a separate Hushh execution contract.
