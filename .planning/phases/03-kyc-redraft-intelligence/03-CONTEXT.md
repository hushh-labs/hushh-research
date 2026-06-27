# Phase 03: KYC Redraft Intelligence (PII-tokenized LLM rewrite) - Context

**Gathered:** 2026-06-25
**Status:** Ready for planning
**Source:** Live codebase exploration (frontend + backend + LLM integration) + decisions A–I
**Origin:** The KYC "Redraft" box exists and is fully wired, but the instruction never
reaches a model — it is parsed by regex keyword matching
(`redraftTransformFromInstructions`, `one-kyc-approved-disclosure-renderer.ts:264`) into a
fixed set of formatting flags (`compact`, `bulletList`, `formal`, `table`, …). Any
instruction outside that vocabulary (e.g. "rephrase the intro to sound warmer", "drop the
second paragraph") silently no-ops. This was deliberate: KYC is **strict zero-knowledge** —
decrypted PKM plaintext never reaches the hushh backend, and `draft_body` is `NULL`-constrained.

<domain>
## Phase Boundary

Give the KYC "Redraft" feature **real LLM intelligence** for free-form instructions, while
keeping the zero-knowledge guarantee literally intact: **no real PII value ever reaches the
hushh backend or the model provider.**

The mechanism is **PII-tokenization (redact → rewrite → re-fill):**
1. The client builds the draft from its structured model (`KycDraftRenderModel` /
   `approvedValues`) as it does today.
2. The client emits a **PII-redacted template** — every value replaced by an opaque
   placeholder (`{{F0}}`, `{{F1}}`, …) — keeping the token→value map **only in the browser**.
3. The redacted template + the user's instruction is sent to **server-side Gemini Vertex**
   (the existing Kai LLM infra) via a new backend proxy endpoint. The backend and Gemini see
   **only prose + placeholders, never a real value.**
4. The rewritten template comes back; the client validates token integrity, **re-substitutes
   the real values locally**, and runs the result through the existing `buildDraft`
   validation + `draftHash` binding.
5. The user reviews the rewritten draft and approves/sends via the unchanged
   `send-approved-reply` flow.

This is ~60% **backend** (consent-protocol: new scope + manifest flag + redact-safe LLM proxy
endpoint mirroring the Kai Gemini call) and ~40% **frontend** (hushh-webapp: redaction,
LLM-path branch in `runAction("redraft")`, re-substitution + validation, consent/disclosure
UI). The existing regex path is **kept** as a fast local path for simple keyword instructions.

The work is split into **four waves**, executed in order:

- **Wave 1 — Consent scope + manifest carve-out.** Add the `agent.kyc.redraft.llm` optional
  scope; add a documented manifest capability flag for the narrow tokenized-transit
  carve-out. Acceptance: scope resolvable + gated; strict-ZK *value* gate otherwise unchanged.
- **Wave 2 — Backend redact-safe LLM proxy.** New endpoint that validates consent, forwards
  the redacted template + instruction to Gemini Vertex with a token-preserving prompt, and
  returns the rewritten template. Never persists or logs the body. Acceptance: tokens
  preserved exactly; `draft_body` stays NULL; no body in logs.
- **Wave 3 — Frontend redact → rewrite → re-fill pipeline.** Client redaction from the render
  model, LLM-path branch in `runAction`, token-integrity check, re-substitution, re-validation
  via `buildDraft`. Acceptance: a free-form instruction produces a correctly re-filled,
  validated draft with all consented fields intact.
- **Wave 4 — Routing, disclosure UI, guardrails + tests.** Auto-route keyword instructions to
  the fast regex path and free-form to the LLM path (with override); consent/disclosure prompt;
  field-integrity guardrails; e2e + unit tests. Acceptance: "make it short" stays local;
  "rephrase warmer" goes LLM; dropped/added tokens are rejected; human review still required.

</domain>

<decisions>
## Implementation Decisions

### Locked decisions (A–I)
- **D-A (Goal): Real LLM rewriting of the KYC approved-disclosure draft from free-form
  instructions**, beyond today's regex formatting flags. The regex path is **kept** as the
  fast local path for keyword-only instructions (see D-F).
- **D-B (Trust model = PII tokenization):** The client redacts **all** PII values to opaque
  placeholders **before any data leaves the device**. The LLM and the backend only ever see
  the PII-free template (prose + placeholders). The token→value map and re-substitution stay
  **client-side only**. No real identity value (name, address, DOB, phone, bank, etc.) is ever
  transmitted off-device.
- **D-C (LLM target = server Gemini Vertex):** Reuse the existing server-side Gemini Vertex
  client (`operons/kai/llm.py`) via a **new backend proxy endpoint**. No new provider, no
  browser→provider boundary, no ephemeral-token machinery. (Explicitly chosen over the
  browser→provider-direct/ephemeral approach because tokenization removes the need to expose
  the browser to a provider at all.)
- **D-D (ZK carve-out — explicit & narrow):** Real PII values **NEVER** reach the backend or
  Gemini. A new, **documented** capability permits **PII-redacted templates to *transit* the
  backend to Gemini, transiently** — **never persisted, never logged**. `draft_body` stays
  `NULL`. A new KYC manifest flag (e.g. `llm_redraft_tokenized: true`) documents this narrowing
  from "backend sees nothing" to "backend sees a PII-free template, transiently, never stored".
  The strict-ZK **value** gate (`is_strict_zero_knowledge`, `backend_plaintext_allowed: false`
  for *draft bodies / values*) is otherwise unchanged.
- **D-E (Consent + disclosure):** New **optional** scope `agent.kyc.redraft.llm`. The LLM path
  is gated on this scope. The redraft UI must disclose, before the first LLM redraft: *"AI will
  rewrite your draft. Only redacted placeholders are sent — never your actual details."* Block
  the LLM path until acknowledged.
- **D-F (Routing / backward compat):** Keep the regex `redraftTransformFromInstructions` path
  as a **fast local path** for keyword-only instructions; route free-form / non-keyword
  instructions to the LLM path. **Auto-detect with an explicit override.** Both paths rebuild
  the draft via `buildDraft` and re-enter the same validation.
- **D-G (Forward-compat):** The redact → rewrite → re-fill pipeline must be **LLM-target-
  agnostic** — the rewrite call is an injectable interface so server-Gemini-today can be
  swapped for an **on-device model later** with **zero rearchitecture** (only the call target
  changes).
- **D-H (Guardrails):**
  1. **Redaction completeness** — every value in `approvedValues` (and any other rendered
     value span) is tokenized before send; assert nothing slips through.
  2. **Token integrity** — on LLM output, each placeholder appears **exactly once**, with no
     invented/dropped/duplicated tokens; otherwise **reject and fall back** (to the prior draft
     or the regex path), never silently send a mangled draft.
  3. **Field re-validation** — after re-substitution, re-run the existing approved-disclosure
     validation (missing-fields check + `draftHash` binding) so the LLM cannot add, drop, or
     alter a consented field.
  4. **Human review mandatory** — the rewritten draft is shown for review; the unchanged
     `send-approved-reply` flow is the only way it leaves. No auto-send.
  5. **No-persist / no-log** — the backend proxy endpoint must not store or log the template
     body; `draft_body` stays `NULL`; only revision metadata + an instruction **hash** is
     recorded (mirroring the existing `last_redraft_instruction_hash`).
- **D-I (Process):** Run as this GSD phase 03 (context → research → plan → execute) given the
  PII sensitivity and the ZK carve-out.

### Claude's Discretion
- Placeholder token format (`{{F0}}` vs semantic `{{FULL_NAME}}`) — choose whatever is most
  robust to LLM token-preservation; opaque indexed tokens are likely safest.
- Whether routing keyword-vs-free-form is auto-detected by reusing the regex keyword set as a
  "this is a pure-format instruction" detector, plus an explicit UI toggle.
- Exact Gemini model + params for the rewrite (reuse Kai constants / `gemini-3-flash-preview`
  class; temperature low for fidelity).
- Whether the redacted template is derived from the plaintext body or rebuilt directly from
  `KycDraftRenderModel` (the latter is cleaner — the renderer already separates prose vs value
  spans).
- New endpoint path/name and request/response schema shape.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.** Paths are repo-relative;
line numbers verified 2026-06-25 via exploration.

### Frontend — KYC page + redraft UI
- `hushh-webapp/app/one/kyc/page.tsx` — `OneKycWorkspace` (the stateful component);
  `DraftReplyPreview` (2286-2305); draft render block (1913-1929); **Redraft box**
  `<Textarea>`+`<Button>` (1952-1985); `redraftInstructions` state (317);
  `runAction("redraft", …)` handler (954-1031) — **the LLM branch goes here**;
  `selectedCanReviewDraft` gate (400); local `buildDraft` re-call after redraft (1017-1025).
- `hushh-webapp/lib/services/one-kyc-service.ts` — `redraft()` (283-302) → `POST
  /api/one/kyc/workflows/{id}/redraft`. Add the new LLM-rewrite client method here.
- `hushh-webapp/lib/services/one-kyc-client-zk-service.ts` — `buildDraft()` (1350-1434);
  `KycDraftBuildResult` type (55-68); `decryptScopedExport` (1270-1348). The
  redact/re-substitute logic lives alongside `buildDraft`.
- `hushh-webapp/lib/services/one-kyc-approved-disclosure-renderer.ts` —
  `redraftTransformFromInstructions` (264-279) [the regex path to KEEP as fast lane];
  `buildApprovedDisclosurePlainText` / `buildApprovedDisclosureHtml`; `KycDraftRenderModel`
  (the structured source for deterministic redaction).

### Backend — KYC routes + service
- `consent-protocol/api/routes/one/email.py` — router prefix `/api/one` (30);
  `one_kyc_redraft` handler (533-553); `DraftRedraftRequest` schema (67-69). Add the new
  LLM-rewrite proxy endpoint here.
- `consent-protocol/hushh_mcp/services/one_email_kyc_service.py` — `redraft()` (3804-3884)
  [bumps `draft_revision`, stores `last_redraft_instruction_hash`, sets
  `client_draft_required`]; `_redraft_requests_more_data` (1038-1053) [scope-expansion guard —
  KEEP, LLM must NOT change consented scope]; `is_strict_zero_knowledge` gate (3381);
  `approve_draft` 410 deprecation (3611).
- `consent-protocol/hushh_mcp/agents/kyc/manifest.py` — capability flags (34-44:
  `strict_client_zk_draft_rendering`, `backend_plaintext_allowed: False`); scopes (21-28:
  required `agent.kyc.process`; optional `agent.kyc.draft`, `agent.kyc.writeback`). Add the new
  optional scope + tokenized carve-out flag.
- `consent-protocol/hushh_mcp/agents/kyc/agent.yaml` — agent model `gemini-3-flash-preview`;
  drafting contract prose (6-15).

### LLM integration (the pattern to mirror)
- `consent-protocol/hushh_mcp/operons/kai/llm.py` — `genai.Client(vertexai=True, …)` init
  (43-223; Vertex-only, server creds); prompt-construction + `validate_token(...,
  ConsentScope(...))` gate (e.g. 331, 516); `KAI_LLM_*` params. Mirror this for the redraft
  proxy (different scope, token-preserving prompt, redacted input).
- `consent-protocol/hushh_mcp/constants.py` — KYC scopes (61-63); `GEMINI_MODEL` +
  `KAI_LLM_*` constants (267-305). Add the new scope here.

### Consent / scope validation
- `consent-protocol/hushh_mcp/consent/token.py` — `validate_token`; `validate_token_with_db`.
- `consent-protocol/hushh_mcp/consent/scope_helpers.py` — `scope_matches` (dynamic scope match).

### Data model
- `consent-protocol/db/migrations/049_one_email_kyc_workflows.sql` +
  `050_*` — `one_kyc_workflows`: `draft_body` `NULL`-constrained (migration 050); `metadata`
  JSONB carries `draft_revision`, `last_redraft_source`, `last_redraft_at`,
  `last_redraft_instruction_hash`, `client_draft_required`. The new LLM redraft adds revision
  metadata only — no body, no real PII.

### Reference (why we are NOT doing browser→provider)
- `consent-protocol/api/routes/kai/agent_realtime.py` — ephemeral-token minting (135-180) +
  `agent-realtime-client.ts:387` browser→`api.openai.com`. This is the only precedented
  browser→provider path; tokenization makes it unnecessary here. Documented as the rejected
  alternative.

</canonical_refs>

<specifics>
## Specific Ideas

- The draft is already assembled from a **structured render model** (`KycDraftRenderModel` /
  `approvedValues: Record<string,string>`), so the redacted template can be produced
  **deterministically** — the renderer already knows which spans are values vs framing prose.
  This makes redaction near-free and exact.
- The LLM rewrite prompt must be **token-preserving and constrained**: "Rewrite this email per
  the instruction. Preserve every `{{TOKEN}}` exactly as-is. Do not add, remove, rename, or
  invent placeholders. Output only the rewritten email." Low temperature.
- Because the input is PII-free, the **existing server-side Gemini Vertex** is sufficient — no
  new provider, no key handling on the client, no ephemeral tokens.
- The carve-out is a **narrowing, not an abandonment**, of strict-ZK: values stay on-device;
  only a PII-free template transits, transiently, never stored. This must be stated explicitly
  in the manifest and enforced (no-log/no-persist) so the guarantee remains auditable.
- Forward-compat is a first-class requirement (D-G): the rewrite call is an interface so a
  future on-device model is a drop-in, with the redact/re-fill plumbing unchanged.

</specifics>

<deferred>
## Deferred Ideas

- **Browser→provider direct / BYOK / on-device model** — future privacy tiers. D-G keeps the
  pipeline target-swappable so these drop in later without rearchitecture.
- **LLM reasoning over literal PII values** (e.g. reformat a phone number, abbreviate a state
  code) — out of scope; the LLM only sees placeholders. Handle later with deterministic
  client-side post-processing if needed.
- **LLM-driven scope expansion** ("also include my portfolio") — out of scope; the existing
  `_redraft_requests_more_data` guard stays in force. The LLM never changes consented scope.
- **Persisting instructions / rewritten bodies server-side** — explicitly never; only a hash +
  revision metadata, as today.

</deferred>

---

*Phase: 03-kyc-redraft-intelligence*
*Context gathered 2026-06-25 from live codebase exploration + decisions A–I*
