# Plaid Vault Passthrough


## Visual Context

Canonical visual owner: [Kai Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Why

The vault-backed flow seals a person's Plaid access token and financial snapshot in **their**
vault after the device receives each response. The backend transiently handles access tokens
and readable Plaid responses in process memory to make the provider calls; this route does not
persist those payloads. This describes the vault route only. Existing server-held records
remain until the per-environment retirement procedure and migration are complete.

- No persistent server registry for connections created through this vault route.
- No webhooks: the device refreshes when the person unlocks the app.
- Raw records land in the owner's vault under the financial branches `connections_v1`,
  `accounts_v1`, `holdings_v1`, `securities_v1`, `transactions_v1` and `derived_v1`. Those
  branches are denied from every grant (`DomainSharingPolicy` for `financial`, mirrored in
  `hushh-webapp/lib/consent/pkm-scope-policy.ts`). Only `attr.financial.summary.*` (bands and
  percentages) is requestable.

## Contract

Router: `consent-protocol/api/routes/kai/plaid_vault.py`, mounted under the Kai router at
`/api/kai/plaid/vault`. All bodies are JSON, validated with Pydantic (`extra="forbid"`,
bounded lengths, opaque-token character set).

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/kai/plaid/vault/link-token` | `{platform: "web"\|"ios"\|"android", redirect_uri?: string\|null, sandbox_proof?: boolean, access_token?: string}` | `{link_token, expiration}` |
| POST | `/api/kai/plaid/vault/exchange` | `{public_token}` | `{access_token, item_id, institution: {id, name}\|null, products, consented_products}` |
| POST | `/api/kai/plaid/vault/snapshot` | `{access_token, transactions_cursor?: string\|null}` | see below |
| POST | `/api/kai/plaid/vault/remove` | `{access_token}` | `{removed: true}` |

`/snapshot` response:

```json
{
  "item": {"item_id": "...", "institution_id": "...", "products": [], "consented_products": [],
           "error": {"code": "ITEM_LOGIN_REQUIRED", "message": "..."} },
  "accounts": ["...Plaid accounts, passed through..."],
  "investments": {"holdings": [], "securities": []},
  "transactions": {"added": [], "modified": [], "removed": [], "next_cursor": "...",
                   "has_more": false, "pages": 1}
}
```

- `investments` or `transactions` may instead be `{"unavailable": "<code>"}` (for example
  `PRODUCTS_NOT_SUPPORTED`, `NO_INVESTMENT_ACCOUNTS`, `PRODUCT_NOT_READY`). Holdings are only
  requested when the Item already has `investments`, because calling the endpoint on an Item
  without it would add (and bill) the product.
- A connection that needs re-authentication (`ITEM_LOGIN_REQUIRED` and other `ITEM_ERROR`s)
  returns **HTTP 200** with `item.error` set, so the device can prompt re-link.
- Transactions use `/transactions/sync`, looping `has_more` up to 10 pages; the device keeps
  the returned `next_cursor` in its vault and sends it next time. A
  `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` restarts the loop once from the original cursor.
- `/exchange` never loses a freshly minted token: if the follow-up `/item/get` or
  `/institutions/get_by_id` fails, it still returns the token with partial metadata.
- `/remove` is idempotent: `ITEM_NOT_FOUND` counts as removed.
- Plaid `client_user_id` is `hv1_` + HMAC-SHA256 of the user id under `APP_SIGNING_KEY`:
  stable per person, never the raw id or an email.
- `access_token` on `/link-token` asks for **update mode** (relink a sealed connection that
  needs a new login): the token is sent to Plaid with no products, and is never stored or
  logged.
- The link token carries no `webhook`, and `apply_link_platform` handles
  `android_package_name` versus `redirect_uri`.
- `sandbox_proof` is an opt-in, non-secret local-test marker. The server
  accepts it only when both its resolved `PlaidRuntimeConfig` environment is
  `sandbox` **and** the process has an explicit `local`/`test` deployment
  identity plus `HUSHH_LOCAL_PLAID_SANDBOX_PROOF=true`. Any Cloud Run identity,
  missing or conflicting deployment metadata, `dev`, UAT, and production
  reject it before calling Plaid even if they use sandbox keys. The iOS proof
  also verifies a non-secret, Next-emitted runtime attestation copied from the
  exact local WebView export. Unmarked clients retain the normal Link-token
  flow.

## Route guarantees and limits

- **Auth:** every endpoint requires the `VAULT_OWNER` consent token through
  `require_vault_owner_token` (the same dependency the consent-gated Kai routes use).
  Missing or invalid tokens get 401; a token with another scope is refused.
- **No persistent route storage:** the module has no database import and never calls
  `get_plaid_portfolio_service()`; a test patches `get_db` to raise and exercises every
  endpoint. This does not mean the backend never processes readable tokens or records, and it
  does not describe pre-existing server-held data.
- **No body logging:** failure logs carry only the route name, Plaid `error_code`,
  `error_type` and HTTP status. The shared observability middleware logs route template,
  status and latency only. Error responses carry a code and a fixed safe message, never
  Plaid's payload.
- **Backend cache policy:** every backend response, including auth failures and validation
  errors, carries `Cache-Control: no-store`. The generic Next Kai proxy currently rebuilds
  JSON responses; browser-facing propagation still needs a route-level check. Validation
  errors are re-rendered without the rejected `input`, so a malformed token is never echoed
  back.

Tests: `consent-protocol/tests/test_plaid_vault_routes.py` (Plaid is never called; UAT's Plaid
is production).

## Device behaviour

Owner: `hushh-webapp/lib/kai/plaid-vault/vault-sync.ts`.

- **Connect** (`connectVaultPlaid`, `sealVaultPlaidConnection`): open Link, exchange, read the
  first snapshot, then one owner-confirmed `replace_domain` write through
  `PkmWriteCoordinator`. If the read or the write fails, the Item is removed at Plaid.
- **Orphan guard** (`hushh-webapp/lib/kai/plaid-vault/pending-seal.ts`): between the exchange
  and the save, the token is recorded in the vault-key-encrypted device cache
  (`plaid_vault_pending_seals_v1`, 30-day TTL) and cleared once the save lands. On the next
  unlock, `UnlockWarmOrchestrator` disconnects any record whose Item is not in
  `connections_v1`. It fails closed: with no vault read, nothing is disconnected.
- **Refresh on unlock**: once per vault session, single-flight per person.
- **Relink** (`relinkVaultPlaid`): update-mode link token from the sealed token, then a forced
  refresh. Nothing new is sealed, because the access token does not change.
- **Web OAuth return**: on the web an OAuth bank takes the whole page away. Before Link opens,
  `rememberVaultOAuthReturn` stores `{linkToken, redirectUri, returnPath, onboardingAttemptId?,
  relinkItemId?}` in tab session storage (30 minutes, single use; never an access token).
  `/one/kai/plaid/oauth/return` sits behind the vault unlock screen and calls
  `completeVaultOAuthReturn`, which re-opens Link with `receivedRedirectUri` (the minted https
  URI plus the bank's query) and then seals, or refreshes for a relink. Native shells keep
  Link in their own process and skip this.

## Legacy server custody retirement status

The audited working tree removes the previous server-stored routes and services. At the audit
revision these source and migration edits are uncommitted, so this is not evidence that any
environment has applied them. Existing encrypted database rows and Plaid Items remain until
the retirement script succeeds for that environment and migration 239 is confirmed applied.

Before deleting or resetting an account, the device revokes each sealed connection (and any
unsaved link) at Plaid (`revokeVaultBanksBeforeErasure` in
`hushh-webapp/lib/flows/delete-account.ts`); if one cannot be revoked, deletion stops. Since
the connection token is sealed to the owner's vault, this cleanup requires an unlocked device.

Retirement order per environment:

1. Dry run: `python3 consent-protocol/scripts/ops/plaid_server_custody_retire.py`. It prints
   counts only: live Items per table, which Plaid environment each live token belongs to,
   regulated funding record counts, the Plaid client environment, the database target and
   its `database_fingerprint`.
2. `... --execute --confirm-env <ENVIRONMENT> --confirm-db <database_fingerprint>`:
   - refuses before any access if either confirmation differs;
   - touches only tokens minted in the Plaid client's environment, so an environment can
     need one pass per Plaid environment (production for real links, sandbox for test
     leftovers);
   - calls Plaid `/item/remove` for every live Item whose token matches the client's Plaid
     environment, then deletes its rows;
   - never sends or deletes a token from another environment (`environment_mismatch_kept`);
   - `INVALID_ACCESS_TOKEN` counts as already gone only in the matching environment;
   - a funding Item referenced by regulated records (transfers, trade intents) is revoked
     and marked `removed`, never deleted.

   Idempotent; prints counts and Plaid `error_code` counts only.
3. Migration `239_drop_server_plaid_custody.sql` in the working tree drops `kai_plaid_*`,
   `kai_portfolio_source_preferences`, and every `kai_funding_*` table. Confirm it is included
   in the target lane and verify its migration ledger after deployment. It **aborts** while
   any Item is still live or regulated funding records exist. Those records need an export and
   an explicit retention decision first.

People re-link through this passthrough. `PLAID_ACCESS_TOKEN_KEY` and
`FUNDING_SECRET_ENCRYPTION_KEY` remain until retirement and migration are verified in every
environment that still holds legacy rows.
