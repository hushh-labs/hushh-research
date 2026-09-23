# Plaid Vault Passthrough


## Visual Context

Canonical visual owner: [Kai Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Why

Founder decision, 2026-09-23: a person's Plaid access token is sealed in **their** vault,
end to end (BYOK). Hussh never stores it or any readable financial information. Hussh keeps
only its own Plaid client secret, so the server calls Plaid on behalf of the device,
statelessly, and forgets the result as soon as the response is sent.

- No server registry of connections: no `item_id` rows, no resume-session rows.
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
| POST | `/api/kai/plaid/vault/link-token` | `{platform: "web"\|"ios"\|"android", redirect_uri?: string\|null}` | `{link_token, expiration}` |
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
- The link token carries no `webhook`, and `apply_link_platform` handles
  `android_package_name` versus `redirect_uri`.

## Guarantees

- **Auth:** every endpoint requires the `VAULT_OWNER` consent token through
  `require_vault_owner_token` (the same dependency the consent-gated Kai routes use).
  Missing or invalid tokens get 401; a token with another scope is refused.
- **No storage:** the module has no database import and never calls
  `get_plaid_portfolio_service()`; a test patches `get_db` to raise and exercises every endpoint.
- **No body logging:** failure logs carry only the route name, Plaid `error_code`,
  `error_type` and HTTP status. The shared observability middleware logs route template,
  status and latency only. Error responses carry a code and a fixed safe message, never
  Plaid's payload.
- **No caching:** every response, including auth failures and validation errors, carries
  `Cache-Control: no-store`. Validation errors are re-rendered without the rejected `input`,
  so a malformed token is never echoed back.

Tests: `consent-protocol/tests/test_plaid_vault_routes.py` (Plaid is never called; UAT's Plaid
is production).

## Still legacy

The server-stored flow in `consent-protocol/api/routes/kai/plaid.py` and
`plaid_portfolio_service.py` (encrypted access tokens in server storage, webhook-driven
refresh, funding and transfer routes) is unchanged and still serves existing clients. Moving
the device onto this passthrough, migrating existing Items, and retiring the server-stored
investment flow are separate follow-ups.
