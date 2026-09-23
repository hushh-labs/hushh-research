# Plaid Activation and Testing


## Visual Context

Canonical visual owner: [Guides Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Runbook for enabling Kai’s read-only Plaid brokerage connectivity on localhost, UAT, and hosted domains.

## What This Enables

- bank and brokerage Link connect, with the new connection sealed in the person's vault; the vault route does not persist Plaid tokens or snapshots server-side
- OAuth banks on web, iOS and Android
- accounts, holdings, securities and transactions
- refresh on unlock and on an explicit Refresh
- relink (Plaid update mode) for a connection that needs a new login
- read-only Plaid source in dashboard, debate context, and optimize context

It does not enable live trading. Contract and device behaviour:
[Plaid Vault Passthrough](../reference/kai/plaid-vault-passthrough.md).
The backend and web proxy process readable provider responses transiently. Legacy server-held
Items can coexist until migration 239 and environment-specific retirement and disconnection
are verified.

## Required Allowlisted Redirect URIs

Register the full callback path in Plaid Dashboard:

- `http://localhost:3000/one/kai/plaid/oauth/return`
- `https://uat.one.hushh.ai/one/kai/plaid/oauth/return`
- `https://one.hushh.ai/one/kai/plaid/oauth/return`

Plaid requires the full absolute URI, not just the domain. Native Android sends no redirect
URI; it registers the app package name in the Plaid dashboard instead.

## Backend Env

Set these in the backend runtime profile:

- `PLAID_ENV=sandbox`
- `PLAID_CLIENT_ID=...`
- `PLAID_SECRET=...`
- `PLAID_CLIENT_NAME=Hussh Kai`
- `PLAID_COUNTRY_CODES=US`
- `PLAID_REDIRECT_PATH=/one/kai/plaid/oauth/return`
- `PLAID_TX_HISTORY_DAYS=730`

`APP_FRONTEND_ORIGIN` must match the active frontend origin for the current profile.

The vault flow uses no webhooks. `PLAID_WEBHOOK_URL` is still read by the Plaid config and
required by the deploy lanes until that requirement is removed; its value is not sent to Plaid.
`PLAID_ACCESS_TOKEN_KEY` exists only for the one-time server-custody retirement script.

## Localhost

- frontend: `http://localhost:3000`
- backend runtime file: `consent-protocol/.env`

## Hosted

- UAT: `https://uat.one.hushh.ai` (UAT uses **production** Plaid: never link test credentials
  or capture bank screens there)
- Prod-like: `https://one.hushh.ai`

## Activation Steps

1. Start the backend and the frontend on matching origins.
2. Unlock the vault, open Finance, and click `Connect a bank`.
3. Complete Link. The connection and its first snapshot are saved to the vault in one
   owner-confirmed write.
4. For OAuth institutions on the web, the bank takes the page away and returns to
   `/one/kai/plaid/oauth/return`; unlock again and Link finishes there.

### Native OAuth return

Native builds run Plaid's own SDK (LinkKit on iOS, the Link SDK on Android), so the bank's
return lands back in Link inside the app. iOS mints the link token with the matching hosted
HTTPS redirect URI, which the OS may deliver to the app through a Universal Link; it must not
pass `app://localhost` back to Plaid.

Before testing on a device, verify both hosted association documents:

```bash
python3 scripts/ops/verify_passkey_domain_associations.py \
  --project <uat-project-id> \
  --origin https://uat.one.hushh.ai
python3 scripts/ops/verify_passkey_domain_associations.py \
  --project <production-project-id> \
  --origin https://one.hushh.ai
```

The verifier checks the app identity, certificate fingerprints, and the
OAuth-return link paths. A 200 response alone is insufficient. After repairing
an association document, reinstall the iOS app or allow Apple’s association
cache to refresh; on Android, repeat the verified-link check on the device.

BYOK note:

- the access token and every record live only in the person's encrypted vault
- the web OAuth return keeps only the link token (never an access token) in tab session
  storage for 30 minutes, single use; the vault key is never persisted

### Statement upload and Save to Vault

The supported statement path is:

`sample PDF or user PDF/CSV → parse → review → unlock/create Vault → encrypted financial-domain write → structured statement snapshot → Kai`

The raw PDF is not persisted to PKM. The save overlay is complete once the
canonical encrypted financial write and local cache projection finish. The
statement source preference and post-save setup callbacks are auxiliary and
must not keep the save control spinning indefinitely; a slow auxiliary call is
reported and can be retried independently.

Validate both completion branches:

- save a preloaded sample statement and confirm the loading state exits on success
- save a user-uploaded PDF or CSV and confirm the loading state exits on parse,
  Vault, backend, or timeout error
- after a successful save, reload the Finance view and confirm the structured
  statement snapshot and editable Statement source are present
- on a native build, repeat the same flow after returning from Plaid and confirm
  the app resumes instead of opening a stranded browser tab

## Expected Runtime Behavior

- `Statement` stays editable
- `Plaid` is read-only
- `Combined` is comparison-only
- transaction activity appears in the dashboard when broker activity exists
- unlocking refreshes sealed connections in the background once per vault session

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

- use an OAuth institution (sandbox: Platypus OAuth Bank)
- confirm the bank page and the return to Link (native) or to `/one/kai/plaid/oauth/return` (web)
- confirm the connection is sealed

### Refresh and relink

- lock and unlock: the connection refreshes once
- force a sandbox Item into `ITEM_LOGIN_REQUIRED`, relink it, and confirm it refreshes without
  a new connection

### Source rules

- `Statement`: editable
- `Plaid`: read-only
- `Combined`: cannot launch Debate or Optimize directly

## Edge Cases To Validate

- missing `cost_basis`
- stale or missing `institution_price_as_of`
- a connection returning `ITEM_LOGIN_REQUIRED` (shows needs relink)
- the app closed between the token exchange and the vault save (next unlock disconnects it)
- duplicate institution relink attempt
- reconnect/update-mode success

## Verification Commands

- `cd consent-protocol && .venv/bin/python -m pytest tests/test_plaid_vault_routes.py`
- `cd hushh-webapp && npx vitest run __tests__/lib/plaid-vault`
- `cd hushh-webapp && npm run typecheck`

## Capability Reminder

Plaid is only the read-only brokerage ingestion layer. Future trade execution must use broker-specific APIs behind a separate Hussh execution contract.
