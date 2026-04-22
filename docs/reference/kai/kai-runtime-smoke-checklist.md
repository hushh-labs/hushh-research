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
   - unlock with the configured Kai/reviewer passphrase from env
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
   - `/kai/import`
   - `/kai`
   - `/kai/plaid/oauth/return`
   - `/kai/portfolio`
   - `/kai/analysis`
   - `/kai/optimize`
 4. Verify required voice routes are present and reachable in the protected API surface:
   - `/api/kai/voice/capability`
   - `/api/kai/voice/plan`
   - `/api/kai/voice/compose`
   - `/api/kai/voice/stt`
   - `/api/kai/voice/tts`

## 0a) Voice Runtime Sanity
1. Open a signed-in Kai route where voice is eligible.
2. Confirm voice capability reports enabled for the current user/runtime and that the mic surface can enter listening state.
3. Run one `answer_now` turn such as:
   - `Who are you?`
4. Run one `execute_and_wait` turn such as:
   - `Take me to my profile.`
5. Run one post-navigation explanation turn such as:
   - `Open Gmail and tell me what I can do here.`
6. Run one `start_background_and_ack` turn such as:
   - `Analyze Nvidia.`
7. Confirm:
   - planner/dispatch/tts stages progress without a generic `stt_unusable` fallback,
   - successful navigation waits for route/screen settlement before final speech,
   - analysis start responds with an acknowledgement rather than a fake completion claim,
   - final spoken text comes from the post-execution compose path or the explicit deterministic fallback.

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
