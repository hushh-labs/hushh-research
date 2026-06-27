# Phase 03: KYC Redraft Intelligence — Research

**Researched:** 2026-06-25
**Method:** Direct codebase exploration (frontend, backend, LLM integration) — file:line verified.
**Question answered:** *What do we need to give the KYC "Redraft" feature real LLM intelligence
without breaking the zero-knowledge guarantee?*

---

## 1. Current state — the feature exists but has no intelligence

The "Draft reply" + "Redraft" UI is **fully wired end-to-end**; nothing is stubbed.

- **Draft display:** `DraftReplyPreview` (`hushh-webapp/app/one/kyc/page.tsx:2286-2305`),
  rendered at `:1913-1929`. Renders `selectedDraft.htmlBody` (via `dangerouslySetInnerHTML`)
  or a `<pre>` fallback.
- **Redraft box:** `<Textarea>` (placeholder *"Make it shorter, more formal, or use a bullet
  list."*) + "Redraft" button at `:1952-1985`, backed by `redraftInstructions` state (`:317`),
  gated by `selectedCanReviewDraft` (`:400`).
- **Handler:** `runAction("redraft", …)` (`:954-1031`) → `OneKycService.redraft()`
  (`one-kyc-service.ts:283-302`) → `POST /api/one/kyc/workflows/{id}/redraft`, then **rebuilds
  the draft client-side** via `OneKycClientZkService.buildDraft({ …, instructions })`
  (`:1017-1025`).

**The gap:** the instruction never reaches a model. `buildDraft` feeds it to
`redraftTransformFromInstructions` (`one-kyc-approved-disclosure-renderer.ts:264-279`), which
is **pure regex keyword matching** → a fixed `RedraftTransform` (`compact`, `formal`,
`bulletList`, `structured`, `table`, `fullDetail`, `human`, `cleanHeaders`). Examples:

```
"make it short"  -> compact: true
"bullet list"    -> bulletList: true, structured: true
"sound warmer"   -> (no keyword match) -> NO-OP
```

Anything outside the keyword vocabulary silently does nothing. That is the entire limitation
we are removing.

---

## 2. Why it was built with regex — the zero-knowledge contract

The draft is generated **entirely client-side**; the backend never builds or stores a plaintext
draft body. This is enforced, not aspirational:

- **agent.yaml (`hushh_mcp/agents/kyc/agent.yaml:11-15`):** *"In strict client-side
  zero-knowledge mode, decrypted PKM plaintext stays in the client; KYC owns the drafting rules
  and validation contract, not backend plaintext draft generation."*
- **manifest.py (`hushh_mcp/agents/kyc/manifest.py:36-44`):** `strict_client_zk_draft_rendering:
  True`, `approved_disclosure_formatter: { strict_client_zk: True, backend_plaintext_allowed:
  False }`.
- **Runtime gate (`one_email_kyc_service.py:3381`):** raises `ONE_KYC_EXPORT_NOT_STRICT` unless
  `export_package["is_strict_zero_knowledge"]` is truthy.
- **DB (`db/migrations/050_*`):** `draft_body` carries a `CHECK (draft_body IS NULL)` constraint
  — the server **cannot** store a draft body.
- **SECURITY.md:116-119:** *"User data is encrypted client-side before transmission. The server
  never has access to the encryption keys… The server cannot decrypt user data, even for support
  purposes."*

**Exact scope of the guarantee:** *decrypted KYC plaintext (the values) never reaches the hushh
backend.* The X25519 keypair lives only in the browser
(`one-kyc-client-zk-service.ts:1270-1348`, `crypto.subtle`); the server holds only ciphertext.

**Implication for this phase:** any design that sends the real draft body to the backend or to
a model provider **violates this contract.** That is what rules out a naive backend LLM and
forces the tokenization approach (§4).

---

## 3. How the rest of the app uses LLMs (precedent inventory)

| Path | Where | Creds | Sees PII? |
|------|-------|-------|-----------|
| (b) Server → Gemini Vertex | `operons/kai/llm.py:43-223`, `api/routes/kai/stream.py` | Server-side Vertex ADC; never on client | Yes — Kai sends name + portfolio context. **But Kai is NOT under the strict-ZK KYC contract.** |
| (a) Browser → OpenAI Realtime | `agent_realtime.py:135-180` → `agent-realtime-client.ts:387` | **Ephemeral** `client_secret` minted server-side | The realtime demo has **no PKM/portfolio access** by design (`agent_realtime.py:33-38`) |
| (c) On-device only | `one-kyc-client-zk-service.ts`, `…-renderer.ts` | none | KYC draft rendering — fully local |

**Key findings:**
- The **server-side Gemini Vertex client** (`genai.Client(vertexai=True, …)`,
  `operons/kai/llm.py:43-223`) is the established, key-safe LLM path. It gates calls with
  `validate_token(token, ConsentScope("agent.kai.analyze"))` (e.g. `:331`, `:516`). **This is
  the exact pattern to mirror for the redraft proxy** — different scope, redacted input,
  token-preserving prompt.
- The browser→provider ephemeral path **exists but does not currently send PKM** anywhere. So
  "the chat agent already sends my PKM over ephemeral" is **false** — the transport exists, the
  PKM flow does not. (This was a point of confusion worth recording.)
- Models/params: `GEMINI_MODEL = "gemini-3.1-pro-preview"`, agent model
  `gemini-3-flash-preview`, `KAI_LLM_TEMPERATURE = 0.0` (`constants.py:267-305`,
  `agent.yaml:6`). Approved models in `config/available_models.txt`.

---

## 4. The chosen design — PII-tokenization (redact → rewrite → re-fill)

Because a redraft instruction ("shorter / warmer / bullets / rephrase the intro") needs the
**prose and structure**, not the literal values, we can strip the values before the model ever
sees them.

```
┌─ browser (has plaintext + token map) ──────────────────────────────┐
│ 1. buildDraft -> KycDraftRenderModel / approvedValues (existing)    │
│ 2. redact: each value -> {{F0}}, {{F1}} ... ; keep map in-browser   │
│ 3. POST { tokenizedTemplate, instruction, tokenKeys } ──────────────┼──▶ backend proxy
│                                                                     │     (sees only template)
│ 6. token-integrity check + re-substitute values locally            │◀──┼── Gemini Vertex
│ 7. buildDraft validation + draftHash binding + human review        │   │   (sees only template)
└────────────────────────────────────────────────────────────────────┘
```

**Why this preserves ZK:** real values never leave the device. The backend and Gemini see only
prose + opaque placeholders. The token→value map and re-substitution are browser-only.

**Why server Gemini is fine here:** the transiting payload is PII-free, so the existing
server-side Vertex client is sufficient — no new provider, no client key handling, no ephemeral
tokens. The narrowing of the contract (from "backend sees nothing" to "backend sees a PII-free
template, transiently, never stored") is documented via a new manifest flag and enforced with
no-log/no-persist + `draft_body` staying `NULL`.

**Deterministic redaction is near-free:** the draft is already built from a structured model
(`KycDraftRenderModel` / `approvedValues`), so the renderer already separates value spans from
framing prose. Redaction iterates `approvedValues` and substitutes placeholders; the same map
re-fills after the rewrite. (Prefer rebuilding the template from the render model over
regex-stripping the rendered body — cleaner and exact.)

**What it cannot do:** reason about literal values (reformat a phone, abbreviate a state). Rare
for redraft; deferred to deterministic post-processing if ever needed.

---

## 5. Integration points (where code changes land)

**Backend (consent-protocol):**
- New optional scope `agent.kyc.redraft.llm` in `constants.py:61-63` + `manifest.py:21-28`.
- New manifest carve-out flag (e.g. `llm_redraft_tokenized: true`) in `manifest.py:34-44`.
- New proxy endpoint in `api/routes/one/email.py` (near `one_kyc_redraft:533-553`): validate
  consent (`validate_token_with_db` + scope), forward redacted template + instruction to Gemini
  (mirror `operons/kai/llm.py`), return rewritten template. **No persist, no log of the body.**
- Optionally record revision metadata in `one_email_kyc_service.py::redraft` (`:3804-3884`)
  via the existing `last_redraft_*` + `draft_revision` fields (hash only).
- Keep `_redraft_requests_more_data` (`:1038-1053`) — LLM must not expand scope.

**Frontend (hushh-webapp):**
- Redaction + re-substitution helpers alongside `buildDraft`
  (`one-kyc-client-zk-service.ts:1350-1434`).
- New client method in `one-kyc-service.ts` (near `redraft:283-302`) for the LLM-rewrite call.
- LLM branch + routing (keyword→regex, free-form→LLM, with override) in `runAction("redraft")`
  (`page.tsx:954-1031`); reuse `redraftTransformFromInstructions` keyword set as the "pure
  format instruction" detector.
- Consent/disclosure prompt + "reviewing AI output" state in the Redraft `SettingsGroup`
  (`page.tsx:1952-1985`).

---

## 6. Risks & open questions

- **Token preservation reliability.** LLMs can drop/duplicate/rename placeholders. *Mitigation:*
  opaque indexed tokens (`{{F0}}`), low temperature, a strict token-preserving prompt, and a
  hard post-check (each token exactly once) with fallback to the prior draft / regex path.
- **Metadata exposure.** The model sees framing prose + which fields exist (not values). The
  backend already knows the field set / scopes / `draft_subject`, so this leaks **no new info**.
  Worth stating explicitly in the manifest rationale.
- **Carve-out auditability.** The narrowing must be enforced, not just documented: no-log /
  no-persist on the endpoint, `draft_body` `NULL` unchanged, and ideally a test asserting the
  endpoint rejects/strips anything resembling a stored body.
- **HTML vs plaintext.** The draft has both `body` and `htmlBody`. Decide whether the LLM
  rewrites plaintext (then re-render HTML deterministically) or both. Plaintext-then-re-render
  is safer for token integrity.
- **Routing false-negatives.** A keyword instruction that *also* implies semantic change (e.g.
  "shorter and warmer") should prefer the LLM path. Auto-detect heuristic + explicit override.

---

## 7. Validation Architecture

- **Unit (backend):** redraft-llm endpoint preserves tokens; rejects calls without
  `agent.kyc.redraft.llm`; never writes `draft_body`; emits no body to logs.
- **Unit (frontend):** redaction covers every `approvedValues` entry; re-substitution is exact;
  token-integrity check rejects dropped/added/duplicated tokens; post-refill `buildDraft`
  validation flags any added/dropped consented field.
- **Integration / e2e:** "make it short" → fast regex path (no network LLM call); "rephrase the
  intro to sound warmer" → LLM path → re-filled, validated draft with all consented fields
  intact; human-review/send flow unchanged.
- **Regression:** existing regex redraft transforms still work; `draft_body` remains `NULL`
  after an LLM redraft; `_redraft_requests_more_data` still blocks scope expansion.

---

*Phase: 03-kyc-redraft-intelligence*
*Research conducted 2026-06-25 via direct codebase exploration.*
