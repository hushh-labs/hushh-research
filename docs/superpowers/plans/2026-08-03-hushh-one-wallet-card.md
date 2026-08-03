# Hushh One Wallet Card — reconciled Product / UX / Engineering plan

Base commit: `58bc866ea` (origin/main). Branch: `feat/hushh-one-wallet-card`.
Discovery: 8 parallel evidence lanes (product, projection backend, frontend, iOS/Capacitor, secrets/CI, security, Apple PassKit research, market benchmarks).

## Visual Map

End-to-end flow. The scanner path (right) is fully unauthenticated and never touches the owner's vault.

```
        OWNER (signed in)                          VISITOR (no app, no account)
        ─────────────────                          ────────────────────────────
   /one/profile → "Wallet Profile"                        scans QR on the pass
              │                                                   │
              ▼                                                   ▼
   POST /api/one/wallet-card                          GET /c/{share_token}   (web page)
   create · edit · pause · rotate · revoke                        │
              │                                                   ▼
              ▼                                    GET /api/one/wallet-card/public/{token}
        one_wallet_cards                                          │
   pass_serial (stable)  ─────────────────────────────────────────┤ SHA-256(token) lookup
   share_token_hash (rotatable, hash only)                        │
   card_payload (server-validated allowlist)                      ▼
              │                                        projection builder (shared)
              ▼                                     active → 200 · paused/unknown → 404
   GET …/pass/{token}.pkpass                        revoked → 410 · expired → 410
   sign with Pass Type ID cert ──► Apple Wallet
   (503 when signing material absent)
```

Preview-as-visitor calls the same projection builder as the public route, so the owner's preview is byte-identical to a stranger's view.

---

## 1. Problem statement

A Hushh One user meets someone — at a conference, a meetup, a hackathon, a recruiter call — and needs to hand over a trusted, current, self-controlled professional identity in seconds. Today they cannot: there is **no visitor-facing render of a Hushh profile anywhere in the product**, and no way to share one.

The product must feel like *a secure digital identity you can show from Apple Wallet whenever you meet someone*. It must not feel like *a decorative Wallet card with a QR that is added once and never used again*.

## 2. What already exists (Premise Verification Gate)

| Capability | Verdict | Evidence |
| --- | --- | --- |
| Owner-published, revocable public projection plane | `already_exists` | `pkm_default_available_projections`, migrations 063 → 090 → 091; publish/list/revoke at [pkm_routes_shared.py:1096-1179](consent-protocol/api/routes/pkm_routes_shared.py) |
| Owner-facing publish UI | `already_exists` but wrong framing | [app/one/marketplace/page.tsx](hushh-webapp/app/one/marketplace/page.tsx) — confirm copy reads "Publish to the marketplace? … so buyers" |
| **Visitor-facing profile page** | **`missing`** | no route, no page, no link, no QR anywhere in repo |
| **Anonymous handle resolution** | **`missing`** | only reader is developer-authenticated `POST /api/v1/public-profile-export`, and it needs `user_id` **and** handle |
| PassKit / `.pkpass` / signing | `missing` | ripgrep: zero hits |
| QR generation | `missing` | no `qrcode`/`segno` in requirements, none in package.json |
| Unauthenticated public route pattern | `already_exists` | `/one/location/request/[token]`, `/portfolio/shared` |
| Rotatable hashed share token | `already_exists` | `one_location_agent_service.py:4291-4356` — `secrets.token_urlsafe(32)` + SHA-256 `_hash_public_value` + `expires_at` + status |
| Advisor public profile (precedent) | `already_exists` | `marketplace_public_profiles` (migration 020:238), unauthenticated `GET /api/marketplace/ria/{id}`, `is_discoverable` pause |

## 3. Decisions (recorded, with rationale)

### D1 — Do **not** reuse `pkm_default_available_projections` for the card. Build a dedicated plane.

Four evidence-backed blockers make reuse unsafe:

1. **Marketplace side-effect (privacy defect).** `marketplace_catalog_service.list_available_listings` selects that table filtered only on non-empty provenance / not revoked / not-self — no source or kind filter — and exposes the owner's **real display name** as `ownerName`. Publishing a Wallet card would silently list the user for sale in the Information Marketplace. Unacceptable.
2. **Handle rotates on every edit.** `store_public_profile_projection` mints a fresh `uuid4()` and revokes the prior row. Every profile edit would invalidate an already-printed QR — directly contradicting the requirement *"The QR does not need to change every time the profile changes."*
3. **Not self-addressing.** `get_public_profile_projection` filters on `user_id` **and** handle. A QR carries only a token, so handle-only resolution does not exist at any layer.
4. **One active row per `(user_id, domain, top_level_scope_path)`.** A composed card spanning name + role + skills + links would be N rows with N handles.

Additionally `projection_payload` is client-authored, validated only as "non-empty dict", and embeds raw owner values — **not safe to serve verbatim to an anonymous browser**.

**Chosen instead:** a dedicated card plane modelled on the *One Location public-invite* pattern, which is the repo's proven, shipped, anonymous-token design. The public projection plane stays exactly as it is, untouched.

### D2 — No Wallet web service. (Deletes a whole subsystem from scope.)

`webServiceURL` and `authenticationToken` are **optional** in Apple's pass reference — only `formatVersion`, `passTypeIdentifier`, `teamIdentifier`, `organizationName`, `description`, `serialNumber` are required. Because the QR carries a URL and the scanned content renders server-side on every scan, **edit / pause / revoke take effect instantly with zero Wallet involvement**. This removes APNs, device registration, the registrations table, and five endpoints.

Accepted cost: we cannot change what is *printed* on an installed pass, nor the baked-in QR payload. Mitigation — keep the pass face minimal and stable (name, photo, logo); put everything volatile behind the QR; implement "rotate" as rotating the **server-side mapping behind a stable pass token**.

### D3 — Pass style `generic`, QR barcode only.

`generic` is Apple's category for passes that don't fit the others and is the only style with a **thumbnail** slot (90pt high, aspect 2:3–3:2) — exactly the headshot. `storeCard`/`coupon` offer only a banner strip; `eventTicket` is semantically entry-to-an-event.

Binding layout constraint: *"generic passes with a square barcode can have a total of up to four secondary and auxiliary fields, combined"* → front is capped at 3 header + 1 primary + 4 combined, plus unlimited `backFields`.

NFC and Personalization are separately approval-gated (loyalty/transit/access-control only, ≥4 weeks, VAS reader keys) and are **out of scope** — barcode passes need no Apple approval.

### D4 — No custom Capacitor plugin, no new entitlement, no app release.

WKWebView **will not** import a `.pkpass` — an in-WebView pass response is a silent no-op. But Capacitor's `decidePolicyFor navigationAction` opens *any* top-level navigation whose URL is off-origin via `UIApplication.shared.open`. The app origin is `App://localhost` with no `server.url` and no `allowNavigation`, so an `https://` pass URL is handed to Safari — which imports `.pkpass` natively. The webapp already ships the helper: `openExternalUrl()` at [lib/utils/browser-navigation.ts:32](hushh-webapp/lib/utils/browser-navigation.ts).

Pass *signing* is server-side and needs no app entitlement; `com.apple.developer.pass-type-identifiers` is only for apps that read/manage passes they own. A custom plugin would also trip `hushh-webapp/scripts/native/verify-native-plugin-contracts.mjs`, which enforces iOS↔Android method parity — and Android has no PassKit.

**Consequence: this feature is web + backend only.** No TestFlight or App Store release is required.

### D5 — Stable pass serial, rotatable share token.

`pass_serial` (UUID) is minted once and never changes — it identifies the installed pass. `share_token` is `secrets.token_urlsafe(32)`, stored **only as a SHA-256 hash**, and is what the QR encodes. Editing card content never touches the token. "Rotate" explicitly mints a new token and re-issues the pass; because the same `passTypeIdentifier` + `serialNumber` overwrites an installed pass, the user re-adds with one tap.

### D6 — The failure mode is the **save**, not the scan.

HiHello's open letter to Apple documents that a raw `.vcf` opened in mobile Safari shows "Done" and a share button, while the real action — "Create New Contact" — is buried at the bottom of a scroll. We therefore do **not** hand the visitor a bare `.vcf` link. The scanned page leads with direct actions (email, call, LinkedIn, GitHub, portfolio) and offers contact download as an explicitly-labelled secondary action with inline guidance.

### D7 — The public page must be excluded from crawlers and analytics.

`app/robots.ts` currently **allow-lists** GPTBot, ClaudeBot, CCBot and PerplexityBot with `allow: "/"`. A new public prefix would be crawled into AI training corpora permanently. The card prefix must be added to `DISALLOWED_PREFIXES`, plus `noindex` headers. GA4 + GTM load unconditionally from the root layout, so every anonymous scanner would be tracked with no consent gate — the card page must not emit analytics.

### D8 — Rate limiting must be explicitly wired.

`SlowAPIMiddleware` is never added and `RateLimits.GLOBAL_PER_IP` is defined but never applied, so an undecorated public route has **zero** limit. Worse, `get_rate_limit_key` falls back to `get_remote_address` and the Dockerfile sets no `--forwarded-allow-ips`, so behind Cloud Run every visitor may share one bucket. The resolve endpoint must carry an explicit decorator and derive the client IP from the forwarded header.

### D9 — Android / desktop graceful degradation.

Apple Wallet does not exist off-iOS. Non-iOS users get the same card as a shareable link (native share sheet / `navigator.share` / clipboard, reusing the One Location share helper). Google Wallet is a deliberate later phase, not v1.

## 4. Scope

**In (v1):** Wallet pass generation + signing; stable QR → public card page; owner setup with smart defaults from existing profile information; preview-as-visitor using the *same* server projection; edit shared fields; pause; rotate; revoke; contact actions on the scanned page; share-link fallback off-iOS; certificate provisioning automation; observability.

**Out (deferred, explicitly):** live location on the card, full PKM sharing, event check-in, access-request workflows, multiple audience presets, verified organisation credentials, emergency identity, Google Wallet, NFC, Personalization, pass push updates.

## 5. Certificate provisioning (no human blocker)

Fully automatable with the Admin-role App Store Connect key already in Secret Manager (`APPSTORE_CONNECT_API_KEY_P8_B64` / `_KEY_ID` / `_ISSUER_ID`, project `hushh-pda-uat`).

1. `POST /v1/passTypeIds` — `{name, identifier: "pass.com.hushh.app.one"}` → `data.id`
2. `openssl` RSA-2048 keypair + CSR inside the runner
3. `POST /v1/certificates` — `certificateType: PASS_TYPE_ID`, `csrContent`, relationship → `passTypeId`
4. Download `certificateContent` (base64 DER) → PEM
5. WWDR **G4** intermediate — verified: `OU=G4`, issuer Apple Root CA, notAfter **2030-12-10**
6. `scripts/ops/upsert_gcp_secret.py` writes cert + private key to Secret Manager via **stdin only**
7. Cloud Run receives them as `--set-secrets` env refs from `deploy/backend.cloudbuild.yaml`, read through `runtime_settings.py`

Reuses the existing ASC JWT client (`scripts/ci/submit-appstore-version.py`, lines 113 and 166-174 — ES256, `aud=appstoreconnect-v1`, exp+19min), the `::add-mask::` / `umask 077` / `chmod 600` hygiene, and the ephemeral venv pattern. **Operational risk is the ~1-year Pass Type ID certificate**, not WWDR — it needs monitored rotation.

### 5.1 Pre-flight (before `--apply`)

Run without `--apply` first. The dry run resolves the Pass Type ID, generates a throwaway keypair/CSR, and — importantly — asserts Secret Manager **write** access on every `--secret-project` before anything irreversible happens. It calls the Cloud Resource Manager `projects.testIamPermissions` REST endpoint directly; there is no `gcloud projects test-iam-permissions` subcommand (SDK 565.0.0 answers `Invalid choice`). `secretmanager.secrets.create` is demanded only when a Wallet secret is genuinely absent, so a rotation-scoped credential passes. Grants must be on the **project** — a grant on the individual secrets is invisible to a project-level check.

### 5.2 Recovery from a partial publish (post-mint)

Step 3 is irreversible and an Apple Pass Type ID account holds a small, finite number of certificate slots. If the mint succeeds but step 6 does not reach every project, the script exits non-zero and names the exact per-project state.

**Do not re-run this command to repair it.** Every run reaches the mint — `--force-new-certificate` obviously, but a plain re-run does too, because a partially published fleet is not "fully provisioned" and falls through to the same call. Each attempt burns another slot.

Repair by copying the material that already exists:

1. Identify a project whose `WALLET_PASS_CERT_PEM` and `WALLET_PASS_KEY_PEM` correspond (the failure message says which ones do not).
2. Read each of `WALLET_PASS_KEY_PEM`, `WALLET_PASS_CERT_PEM`, `WALLET_PASS_WWDR_PEM` from the healthy project and pipe it into the failed one via `scripts/ops/upsert_gcp_secret.py --stdin`. Never let the PEM become an argv entry, a shell variable, or a file on disk.
3. Re-run **without** `--apply`; a converged fleet reports `already-provisioned` and exits 0.
4. Keep `ONE_WALLET_CARD_ENABLED` OFF until step 3 is clean. The signing service returns 503 while material is absent or mixed, so the feature degrades rather than serving passes iOS would reject.

Reads in the verification path retry (3×, backing off) exactly like writes: an unretried transient gcloud failure would otherwise be read as "absent" or "corrupt" and route an operator into this recovery when nothing was actually wrong.

## 6. Success metrics

Repeat usage, not passes added: scans per active card, contact-save / portfolio-open actions per scan, share-scope edits, rotation/revocation usage, setup completion time (< 60s target), pass-generation failure rate, scanner-page load time on mobile networks.

## 7. Regression surface

Untouched by design: `pkm_default_available_projections` and its routes, the Information Marketplace catalogue, the RIA advisor public profile, vault/consent token paths, and every authenticated `/one` route. The new plane is additive with its own table, its own routes, and a feature flag.
