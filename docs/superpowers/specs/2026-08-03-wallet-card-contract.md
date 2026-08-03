# Wallet Card — binding implementation contract

Every implementer MUST conform to this file exactly. Do not invent alternative names, paths, or shapes.

Brand/voice: public prose says **Hussh**; internal identifiers keep legacy `hushh`. One is "the private agent". Prefer "information" over "data" in user-facing copy. Code/API/route/schema identifiers stay exact as written here.

## Visual Map

Layers this contract binds, and the one table they all resolve through.

```
  hushh-webapp/app/one/profile/…        hushh-webapp/app/c/[token]/…
  owner surface (authenticated)         public page (no auth)
             │                                     │
             ▼                                     ▼
  lib/services/wallet-card-service.ts    server-side fetch of the public route
  (only layer allowed to call fetch)               │
             │                                     │
             ▼                                     ▼
  /api/one/wallet-card/*                 /api/one/wallet-card/public/{share_token}
  create · edit · pause · rotate · revoke · preview
             │                                     │
             └──────────────┬──────────────────────┘
                            ▼
              one_wallet_card_service.py
              share token → SHA-256 → one_wallet_cards
                            │
                            ▼
              /api/one/wallet-card/pass/{share_token}.pkpass
              PassKit signing (Pass Type ID cert → WWDR G4)
```

Status mapping is normative: `active` → 200; `paused` and unknown → 404 with the *same* generic body; `revoked` → 410 `{status:revoked}`; expired → 410 `{status:expired}`.

---

## 1. Naming

| Thing | Exact value |
| --- | --- |
| Feature name (user-facing) | Wallet Profile |
| Pass Type Identifier | `pass.com.hushh.app.one` |
| DB table | `one_wallet_cards` |
| Backend route prefix | `/api/one/wallet-card` |
| Public resolve route | `GET /api/one/wallet-card/public/{share_token}` (no auth) |
| Public web page | `/c/[token]` |
| Pass download route | `GET /api/one/wallet-card/pass/{share_token}.pkpass` (no auth) |
| Feature flag env | `ONE_WALLET_CARD_ENABLED` (default `false`) |
| Secret: cert PEM | `WALLET_PASS_CERT_PEM` |
| Secret: private key PEM | `WALLET_PASS_KEY_PEM` |
| Secret: WWDR G4 PEM | `WALLET_PASS_WWDR_PEM` |
| Runtime settings keys | `one_wallet_card_enabled`, `wallet_pass_cert_pem`, `wallet_pass_key_pem`, `wallet_pass_wwdr_pem`, `wallet_pass_team_identifier`, `wallet_pass_type_identifier` |

## 2. Table `one_wallet_cards` (migration `132_one_wallet_card.sql`)

One row per user. Additive only. No changes to any existing table.

| Column | Type | Notes |
| --- | --- | --- |
| `user_id` | TEXT PRIMARY KEY | vault owner |
| `pass_serial` | UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE | stable for the life of the card; identifies the installed pass |
| `share_token_hash` | TEXT NOT NULL UNIQUE | SHA-256 hex of the plaintext token. **Plaintext is NEVER stored.** |
| `share_token_version` | INTEGER NOT NULL DEFAULT 1 | increments on rotate |
| `status` | TEXT NOT NULL DEFAULT 'active' | CHECK IN ('active','paused','revoked') |
| `card_payload` | JSONB NOT NULL DEFAULT '{}'::jsonb | server-validated allowlisted fields only (§3) |
| `display_name` | TEXT | denormalised for pass face |
| `headline` | TEXT | denormalised for pass face |
| `avatar_url` | TEXT | |
| `expires_at` | TIMESTAMPTZ NULL | NULL = no expiry |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| `revoked_at` | TIMESTAMPTZ NULL | |
| `last_scanned_at` | TIMESTAMPTZ NULL | coarse only |
| `scan_count` | BIGINT NOT NULL DEFAULT 0 | aggregate only |

Indexes: unique on `share_token_hash`, unique on `pass_serial`, index on `status`.

**Privacy rule (binding):** never store per-scan rows, IP addresses, user agents, geolocation, or referrers. Only `last_scanned_at` and `scan_count`. This mirrors the location-agent rule that consent metadata must never include coordinates or traces.

Provide `consent-protocol/db/migrations/rollback/132_one_wallet_card_down.sql`.

Account deletion: the card row must be removed by the account deletion cascade.

## 3. `card_payload` allowlist — server-validated, closed set

Any key not in this list is **rejected** (not silently dropped). All values are strings unless noted; all are optional; every one is trimmed and length-capped.

| Key | Max len | Notes |
| --- | --- | --- |
| `full_name` | 80 | |
| `headline` | 120 | e.g. "Founder, Hussh" |
| `organisation` | 80 | company or college |
| `location_label` | 80 | coarse only — city/region. Never coordinates. |
| `summary` | 400 | short professional summary |
| `skills` | 12 items × 40 | array of strings |
| `email` | 254 | validated shape |
| `phone` | 32 | validated shape |
| `website` | 300 | https only |
| `linkedin` | 300 | https only |
| `github` | 300 | https only |
| `portfolio` | 300 | https only |
| `preferred_contact` | 16 | one of `email`,`phone`,`linkedin`,`website` |

URL fields: reject anything not `https://`. Reject `javascript:`, `data:`, and userinfo (`@`) forms. Strings are stored as plain text and **escaped at render time** — never rendered as HTML.

## 4. Owner routes — all `Depends(require_vault_owner_token)` + `token_data["user_id"] == user_id`

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/one/wallet-card` | current card + status + share URL (plaintext token is returned **only** at create/rotate; otherwise the URL is reconstructed client-side from a token the client already holds — see §5) |
| POST | `/api/one/wallet-card` | create or update card_payload; idempotent upsert; returns card |
| POST | `/api/one/wallet-card/rotate` | mint new token (invalidates old immediately), bump `share_token_version`, return plaintext token **once** |
| POST | `/api/one/wallet-card/pause` | status → `paused` |
| POST | `/api/one/wallet-card/resume` | status → `active` |
| DELETE | `/api/one/wallet-card` | status → `revoked`, set `revoked_at` |
| GET | `/api/one/wallet-card/preview` | **preview-as-visitor**: returns the byte-identical projection the public endpoint would return. MUST call the same builder function — no separate code path. |

## 5. Token handling

- Plaintext token = `secrets.token_urlsafe(32)`. Returned to the owner **only** in the create and rotate responses.
- Stored only as SHA-256 hex in `share_token_hash`.
- Lookup is by hash of the presented token. Use `hmac.compare_digest` on the hash comparison.
- The owner client persists the share URL locally so it can render the QR and the Add-to-Wallet link without re-requesting the token.

## 6. Public routes — **no authentication**

`GET /api/one/wallet-card/public/{share_token}`

Returns only the projection built from `card_payload` — never `user_id`, never `pass_serial`, never internal ids, never timestamps beyond a coarse `updated_at` date.

Status handling (binding):
- unknown token → `404` with a generic body
- `paused` → `404` with the **same generic body** as unknown (a paused card must be indistinguishable from a non-existent one)
- `revoked` → `410 Gone` with `{"status":"revoked"}` so the page can show an honest "no longer shared" state
- expired (`expires_at` passed) → `410 Gone` with `{"status":"expired"}`

Must be decorated with an explicit rate limit (the global limiter is **not** wired — `SlowAPIMiddleware` is never added and `GLOBAL_PER_IP` is never applied). Derive client IP from the forwarded header, since Cloud Run otherwise collapses everyone into one bucket.

Response headers: `Cache-Control: private, max-age=0, must-revalidate`, `X-Robots-Tag: noindex, nofollow, noarchive`.

Increment `scan_count` and set `last_scanned_at` **asynchronously / best-effort** — a counter failure must never fail the read.

`GET /api/one/wallet-card/pass/{share_token}.pkpass`

Returns `Content-Type: application/vnd.apple.pkpass`, `Content-Disposition: attachment; filename="hushh-one.pkpass"`. Same status rules. Returns `503` with a friendly code when signing material is absent.

## 7. Pass construction (`generic` style)

Required `pass.json` keys: `formatVersion` (1), `passTypeIdentifier`, `teamIdentifier`, `organizationName`, `description`, `serialNumber` (= `pass_serial`).

Field budget with a square barcode: **3 header + 1 primary + 4 combined secondary/auxiliary**, plus unlimited `backFields`.

- `primaryFields`: full name
- `secondaryFields`: headline
- `auxiliaryFields`: organisation, location_label (only if present)
- `backFields`: summary, links, and a "How this works" note
- `barcodes`: `[{format: "PKBarcodeFormatQR", message: <public card URL>, messageEncoding: "iso-8859-1", altText: <short handle>}]`
- `thumbnail` = headshot (90pt high, aspect 2:3–3:2); `icon` and `logo` required

Signing: `manifest.json` = SHA-1 hex per file keyed by relative path (exclude `.DS_Store`); `signature` = **PKCS#7 detached** signature of `manifest.json` under the Pass Type ID cert key, chained through WWDR **G4**; zip the bundle. Use `cryptography==49.0.0`, already in requirements — add no new signing dependency.

Omit `webServiceURL` and `authenticationToken` entirely (D2 — no web service).

## 8. Frontend

- **Never call `fetch()` from `app/**` or `components/**`** — `hushh-webapp/scripts/architecture/verify-service-layer-boundary.mjs` enforces this with a literal regex. All network access goes through `lib/services/wallet-card-service.ts` using `ApiService.apiFetch` / `apiJson`.
- Public page `/c/[token]` must render for a logged-out stranger: register in `isPublicRoute()`, ensure `OneAuthGate`/`VaultLockGuard` are bypassed, and suppress chrome via `mode: "hidden"` in `lib/navigation/app-route-layout.contract.json`. Precedent to copy: `app/one/location/request/[token]`.
- The public page must emit **no analytics** and must be added to the robots disallow prefixes.
- Owner screens live under `app/one/wallet-card/`.
- Add-to-Wallet uses the existing `openExternalUrl()` (`lib/utils/browser-navigation.ts:32`) so Capacitor hands the URL to Safari — WKWebView cannot import a pass.
- Non-iOS: show share-link actions instead of Add-to-Wallet.

## 9. Copy (use verbatim)

- Entry, before setup: **"Add to Apple Wallet"** / "Keep your Hussh One profile ready to share."
- Setup intro: **"Your profile, ready when you need it"** / "Add a secure Hussh One pass to Apple Wallet and share your selected details with a simple scan."
- Privacy assurance: **"You stay in control"** / "Only the information you select will be visible. You can update or disable access at any time."
- After setup entry: **"Manage Wallet Profile"** / "Control what people see when they scan your pass."
- Success: **"Your Hussh One pass is ready"** / "You can now share your profile directly from Apple Wallet."
- Signing failure (user-facing): "We couldn't create your Wallet pass right now. Please try again in a moment." — log the technical error server-side only.
- Revoked page: "This profile is no longer shared."
- Expired page: "This profile link has expired."

Never use: "Share everything", "Your complete identity", "All your data in one scan", "Unlimited profile access", "Your entire PKM".

## 10. Hard prohibitions

1. Do **not** read, write, or alter `pkm_default_available_projections`, its routes, or its services.
2. Do **not** alter the Information Marketplace catalogue or the RIA advisor profile.
3. Do **not** log the plaintext share token, the private key, or any `card_payload` value.
4. Do **not** add a Capacitor plugin or an iOS entitlement.
5. Do **not** add a Wallet web service, APNs, or device registration.
6. Do **not** store per-scan telemetry rows.
