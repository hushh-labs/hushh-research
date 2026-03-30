# Kai Runtime Smoke Checklist


## Visual Context

Canonical visual owner: [Kai Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Use this lightweight checklist instead of expanding automated test coverage.

## 0) Route/System Audit
1. Run:
   - open local OpenAPI and confirm required Kai API routes exist
   - manually visit the key Kai routes below
 2. Verify required Kai API routes/methods are present in OpenAPI.
 3. Verify frontend route probes pass for:
   - `/kai/import`
   - `/kai`
   - `/kai/plaid/oauth/return`
   - `/kai/portfolio`
   - `/kai/analysis`
   - `/kai/optimize`

## 1) Fresh User Import Flow
1. Sign in with a user that has no `financial` domain.
2. Start onboarding/import, upload a brokerage PDF.
3. Confirm stage timeline streams and holdings preview increments.
4. Confirm no stream reset when vault is created/unlocked mid-import.

## 2) PKM Integrity
1. Run:
   - manual spot-check via Kai dashboard and `/api/pkm/metadata/{user_id}` in the API docs or local API client
2. Confirm:
   - blob domains align with index/registry,
   - `financial` canonical summary count is non-zero when holdings exist,
   - debate context readiness is `true`.

## 3) /kai Cache + UX
1. Open `/kai` and note initial load time.
2. Navigate away and back within 60s.
3. Confirm no unnecessary full re-fetch (screen should be fast and stable).
4. Confirm hero reads as holdings-led context and buttons have expected styles:
   - `Open Dashboard` blue gradient fill
   - `Refresh` fade style

## 3a) Consent Inbox + Manager
1. From the signed-in shell, confirm the shield badge matches the active persona pending summary.
2. Open the shield inbox and confirm:
   - at most 5 rows are shown,
   - internal scroll appears only when needed,
   - `Open consent manager` opens `/consents` for the active persona.
3. Confirm empty pending state does not show pagination chrome in either the inbox or `/consents`.

## 4) Debate Output Reliability
1. Run stock analysis from dashboard/portfolio flow.
2. Confirm quick recommendation card appears with final decision.
3. Confirm decision card PKM context shows non-zero holdings count when applicable.
4. If providers degrade, confirm degraded messaging appears without hard failure.

## 5) Toast Readability
1. Trigger success/warning/error toasts over rich backgrounds.
2. Confirm glass blur/contrast keeps text legible and visually separated from content.

## 6) Mobile Parity Sanity
1. Run:
   - `cd hushh-webapp && npm run verify:parity`
   - `cd hushh-webapp && npm run verify:capacitor:routes`
2. Confirm canonical Kai routes exist in mobile static export mapping.
3. Confirm stream, token guard, and cache-first behavior match web expectations.

## 7) Plaid Brokerage Guardrails
1. Confirm `Statement` remains editable.
2. Confirm `Plaid` remains read-only.
3. Confirm `Combined` remains comparison-only and cannot launch Debate or Optimize directly.
4. If webhook target changed after prior connections, do a one-time operator maintenance pass using Plaid's `/item/webhook/update`.

## 8) Web-Only Behavior Validation
1. Confirm web-only plugins/features remain explicitly documented.
2. Confirm no UI/route dependency assumes native-only plugin behavior on web.
