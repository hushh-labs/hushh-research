# Kai Runtime Smoke Checklist


## Visual Context

Canonical visual owner: [Kai Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Use this lightweight checklist instead of expanding automated test coverage.

Runtime truth note:

1. Use script-first regression for Kai runtime truth:
   - auth/bootstrap
   - debate completion
   - PKM persistence
   - saved analysis history
2. Do not use Playwright unless the proof actually requires a browser:
   - review-mode auth/bootstrap
   - vault unlock and protected-route gating
   - Next client navigation behavior
   - responsive layout, tabs, tooltips, styling, or animation
3. When Playwright is required on a signed-in route:
   - use the reviewer flow
   - unlock with `REVIEWER_VAULT_PASSPHRASE` from a maintainer-only env or secret overlay
   - keep same-session proof on Next client navigation after unlock
4. Treat direct deep links as a separate cold-entry contract, not the same as unlocked navigation.
5. For local debate/history verification, run:
   - `python3 consent-protocol/scripts/local_kai_debate_regression.py`

## 0) Route/System Audit
1. Run:
   - open local OpenAPI and confirm required Kai API routes exist
   - manually visit the key Kai routes below
 2. Verify required Kai API routes/methods are present in OpenAPI.
 3. Verify frontend route probes pass for:
   - `/one/kai/import`
   - `/one/kai`
   - `/one/kai/plaid/oauth/return`
   - `/one/kai?tab=portfolio`
   - `/one/kai/portfolio/holdings`
   - `/one/kai/portfolio/allocation`
   - `/one/kai/portfolio/performance`
   - `/one/kai/portfolio/sources`
   - `/one/kai/analysis`
 4. Verify the protected command endpoints: `POST /api/one/transcriptions`, `POST /api/one/agent-chat/proposals`, and the `/api/one/action-proposals` lifecycle. Obsolete Live clients must receive the explicit retirement response.

## 0a) Voice Runtime Sanity
The microphone now enters the Location command runtime. Ordinary typed Kai text continues through its existing specialist. Use [One Voice Runtime Architecture](../one/one-voice-runtime-architecture.md) for the current contract.

1. Authenticate and unlock. Hold, speak and release; verify the final words reach the transcript. Repeat with accessible tap-to-start/finish.
2. Cancel or background during capture; verify no command submits. Completion must return to idle without restarting listening.
3. Exercise English, Hindi and Hinglish requests for a circle with a supplied name. Verify the actual service result, not only the proposed action.
4. Ask to enable Location with and without permission. Observe the real permission gate and continuation of the same task. Ambiguous people must produce a choice or clarification.
5. Confirm sensitive cards describe the exact people, duration and scope. Change a selected record while a card is open; stale approval must not execute.
6. Exercise a screen-only capability. The card may report that its screen opened; it must not report the underlying operation completed.
7. Terminate before/after effects and at gates. After authentication and unlock, require explicit Resume or Cancel; completed steps must not replay. Check owner changes and 24-hour expiry separately.
8. Check Agent Bar, Chat microphone and Siri entrypoints for zero Gemini Live or generated-audio requests. Repeat the microphone, permission and restart scenarios on web, iOS and Android before release.

## 1) Fresh User Import Flow
1. Sign in with a user that has no `financial` domain.
2. Start onboarding/import, upload a brokerage PDF.
3. Confirm stage timeline streams and holdings preview increments.
4. Confirm no stream reset when vault is created/unlocked mid-import.

## 2) PKM Integrity
1. Run:
   - manual spot-check via Kai dashboard and `/api/pkm/metadata/{user_id}` in the API docs or local API client
2. Confirm:
   - manifest-backed domains align with the metadata route and MCP discovery for the same user,
   - `pkm_index` is not lagging behind manifest truth,
   - `financial` canonical summary count is non-zero when holdings exist,
   - debate context readiness is `true`.
3. For local/UAT Kai drill runs, confirm the no-write PKM rehearsal:
   - starts automatically after sign-in + unlock,
   - records timing in the task center,
   - validates the dummy save without mutating the real PKM rows.
4. For locked profile verification, confirm:
   - locked PKM summary still shows truthful domain/item/source metadata,
   - locked state does not render a false `0 domains / 0 items` view when manifest-backed PKM exists,
   - only decrypted or mutation-sensitive detail stays gated behind unlock.

## 3) `/one/kai` Cache + UX
1. Open `/one/kai` and note initial load time.
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
   - `Open consent manager` opens `/one/consent` for the active persona.
3. Confirm empty pending state does not show pagination chrome in either the inbox or `/one/consent`.

## 4) Debate Output Reliability
1. Run stock analysis from dashboard/portfolio flow.
2. Confirm quick recommendation card appears with final decision.
3. Confirm decision card PKM context shows non-zero holdings count when applicable.
4. If providers degrade, confirm degraded messaging appears without hard failure.
5. Treat the local regression script as the source of truth for whether debate saves into evolved PKM `financial.analysis_history`.

## 4a) Post-upgrade regression gate
1. After the PKM upgrade or no-write rehearsal finishes, confirm these still work on the upgraded contract:
   - dummy save validation,
   - PDF import,
   - Plaid connect / refresh,
   - portfolio optimize,
   - debate over upgraded data,
   - frontend portfolio/dashboard mapping,
   - RIA workspace sanity,
   - consent save + export refresh,
   - dynamic scope expansion,
   - simplified permission bundle rendering.
2. Treat any break in this list as a release blocker for PKM rollout.
3. The automated counterpart for this checklist is [scripts/ci/pkm-upgrade-gate.sh](../../../scripts/ci/pkm-upgrade-gate.sh).
4. When a live runtime base URL is available, run the same gate with `PKM_UPGRADE_RUNTIME_AUDIT_BASE_URL=<base-url>` so the investor onboarding, PKM migration, and RIA onboarding browser audits execute against the runtime you plan to trust.

## 5) Toast Readability
1. Trigger success/warning/error toasts over rich backgrounds.
2. Confirm glass blur/contrast keeps text legible and visually separated from content.

## 6) Mobile Parity Sanity
1. Run:
   - `./bin/hushh native ios --mode uat`
   - `./bin/hushh native android --mode uat`
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
