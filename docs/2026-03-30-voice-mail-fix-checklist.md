# Voice + Mail Fix Checklist (feat/kai-voice-level3)

## Agent A — Voice Backend
- #4 `/voice/understand` rollout pre-STT gate
  - Files: `consent-protocol/api/routes/kai/voice.py`
  - Tests: add/extend voice route/rollout tests for understand path
- #11 Voice upload size defenses
  - Files: `consent-protocol/api/routes/kai/voice.py`
  - Tests: stt/understand upload size rejection/limit tests
- #15 prefer run-manager truth for already_running
  - Files: `consent-protocol/api/routes/kai/voice.py`, `consent-protocol/hushh_mcp/services/voice_intent_service.py`
  - Tests: planner/unit tests for stale runtime flags
- #19 remove `debug_message` leakage from client responses
  - Files: `consent-protocol/api/routes/kai/voice.py`
  - Tests: assert sanitized error payload

## Agent B — Voice Frontend
- #1 grounded tool call canonical dispatch payload
- #2 executed-vs-blocked/invalid structured outcomes
- #3 FSM transitions align runtime
- #12 clear/guard client VAD fallback timer on pause/cancel/mute
- #13 ack TTS failure must not block dispatch
- #14 catch auto-turn async failures deterministically
  - Files: `hushh-webapp/lib/voice/voice-response-executor.ts`, `hushh-webapp/lib/voice/voice-action-dispatcher.ts`, `hushh-webapp/lib/voice/voice-turn-orchestrator.ts`, `hushh-webapp/components/kai/kai-search-bar.tsx`, `hushh-webapp/lib/voice/voice-ui-state-machine.ts`
  - Tests: voice executor/dispatcher/orchestrator/search-bar/FSM tests

## Agent C — Mail Backend
- #5 disconnect cancels in-flight sync + terminal cancel state
- #6 stale queued/running recovery policy (TTL + reconciliation)
- #9 per-message failure isolation in sync loop
- #10 support error sanitization backend
- #21 strip-aware support validation
  - Files: `consent-protocol/hushh_mcp/services/gmail_receipts_service.py`, `consent-protocol/hushh_mcp/services/support_email_service.py`, `consent-protocol/api/routes/kai/support.py`, optionally `consent-protocol/api/routes/kai/gmail.py`
  - Tests: gmail receipts service + support route/service tests

## Agent D — Mail Frontend
- #7 receipts pagination stability
- #8 profile poll non-terminal no false success
- #10 support error UX mapping
- #16 oauth callback replay/idempotent handling
- #20 route-layout contract drift entries
  - Files: `hushh-webapp/app/profile/page.tsx`, `hushh-webapp/app/profile/receipts/page.tsx`, `hushh-webapp/app/profile/gmail/oauth/return/page.tsx`, `hushh-webapp/lib/navigation/app-route-layout.contract.json`
  - Tests: receipts page tests, oauth return tests, profile/support tests, app route-layout contract test

## Agent E — Contracts/Telemetry/Flags
- #17 kaiProxy contract inventory completeness
- #18 direct voice fetch metric parity with apiFetch
- #22 registry API path strings alignment
- #23 route->screen derivation granularity for receipts/investments
- #24 legacy kai-polling safe handling (remove/migrate/guard)
  - Files: `hushh-webapp/route-contracts.json`, `hushh-webapp/scripts/verify-route-contracts.cjs`, `hushh-webapp/lib/services/api-service.ts`, `hushh-webapp/lib/voice/investor-kai-action-registry.ts`, `hushh-webapp/lib/voice/route-screen-derivation.ts`, `hushh-webapp/lib/services/kai-polling.ts`
  - Tests: route-contract verifier, observability/route-map tests, route-screen derivation tests
