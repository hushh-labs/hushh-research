# KYC Agent Enhancement — Phase 2 & Phase 3 planning (handoff)

I'm continuing a multi-phase KYC agent enhancement in the `hushh-research` repo
(branch to base new work on: `feat/kyc-agent-enhancements`, which is at the same
base as latest `origin/main` = `15e37ed8a`). Phase 1 is complete and pushed.
Use the **superpowers:brainstorming** skill first, then **writing-plans**, then
**subagent-driven-development** to execute — same workflow used for Phase 1.

## What Phase 1 already did (context, do NOT redo)
Phase 1 (frontend-only, on the branch) made the KYC email *redraft* render
through the same structured path as the first draft. Spec + plan live at:
- `docs/superpowers/specs/2026-07-02-kyc-draft-redraft-parity-design.md`
- `docs/superpowers/plans/2026-07-02-kyc-draft-redraft-parity.md`
- SDD progress ledger: `.superpowers/sdd/progress.md` (search "KYC Draft/Redraft
  Parity") — includes final review + deferred follow-ups.

Key Phase-1 outcome to know: financial payloads tokenize as a SINGLE `{{F0}}`
token, so the LLM redraft can only reword narrative around the holdings, never
the holdings themselves. Deferred follow-ups (non-blocking): section-title
heading parity, an unconfirmed key/value card-parity question, a
renderModel-consistency test, and the structureFallback UX using error styling.

## The KYC system (already mapped — trust this)
- **Purpose:** One-led, approval-gated, zero-knowledge email intake for
  `one@hushh.ai`. A counterparty emails asking for identity/financial data →
  consent-gated workflow → reply draft built ENTIRELY client-side from decrypted
  PKM → sent in the original Gmail thread → encrypted PKM writeback.
- **Backend brain:** `consent-protocol/hushh_mcp/services/one_email_kyc_service.py`
  (~4,600 lines). Intake classification is REGEX/deterministic
  (`_looks_like_kyc`, `_detect_scope_candidates`). The ONLY LLM call today is
  `redraft_llm()` (tokenized-template rewrite via shared Gemini client in
  `hushh_mcp/operons/kai/llm.py`).
- **The agent is manifest-only:** `consent-protocol/hushh_mcp/agents/kyc/` has
  just `agent.yaml` (model `gemini-3-flash-preview`, thin single-paragraph
  system_instruction, NO `tools:` block) + `manifest.py` + `__init__.py`. No
  `agent.py`, no `tools.py`.
- **DB:** migrations 049–051 (`one_kyc_workflows`, mailbox state, client
  connector registry). Hard ZK floor: `draft_body IS NULL` CHECK; metadata token
  redaction.

## Phase 2 — Make KYC a real ADK sub-agent of One
**Goal:** give KYC the runnable ADK shape that One's wiring ALREADY expects.
KYC is "half-wired": it's in One's specialist metadata
(`agents/one/manifest.py:34-40`), named in One's prompt (`agents/one/agent.yaml`),
has a routing entry + `delegate_to_kyc_agent` (`agents/orchestrator/tools.py`),
and an A2A scope map (`adk_bridge/delegation.py:14`, `agent_kyc →
AGENT_KYC_PROCESS`). What's MISSING: `agents/kyc/agent.py`,
`agents/kyc/tools.py`, and an enriched `agent.yaml`.

**Template to mirror:** the LOCATION agent
(`consent-protocol/hushh_mcp/agents/location/`): `agent.py`
(`LocationAgent(HushhAgent)` + singleton factories injecting tool bundles),
`tools.py` (`@hushh_tool` fns + tool-list bundles), and a rich, tool-referencing
`agent.yaml` system_instruction (invariants, explicit refusals, decision trees
naming tools, clarify/confirm, id/state-safety). KAI is the other full example.

**Important nuances / decisions to resolve in brainstorming:**
1. KYC's real work is a client-side ZK renderer + the email SERVICE, not a
   plaintext ADK agent (`agent.yaml` has `backend_plaintext_allowed: false`).
   So KYC's ADK tools should be control-plane / "propose_*" tools (like
   Location's coordinate-free pattern), NOT plaintext-handling tools.
2. One's `OrchestratorAgent` does NOT call the Location factory directly —
   Location is reached via its own `location_chat_service.py`. Decide whether KYC
   is reached via One's delegate tool loop or an analogous KYC chat service.
3. Fix the manifest drift: `AGENT_KYC_REDRAFT_LLM` is in `manifest.py` but not
   `agent.yaml`.
4. Note from prior features: `hushh_adk/core.py`'s ADK wrapper was incompatible
   with `google-adk==1.28.1`; Location/KAI use a DIRECT-Gemini runner, not the
   ADK LlmAgent path. Check what runner KYC should use (likely direct-Gemini,
   mirroring `location_chat_service.py`).

Please brainstorm Phase 2 with me (one question at a time), write a spec to
`docs/superpowers/specs/`, then a plan, then execute via SDD.

## Phase 3 — LLM comprehension + PKM availability (the headline)
**Goal:** move from deterministic regex intake to an LLM that (a) understands
what the incoming email is ASKING for, and (b) maps it to what the user actually
HAS in PKM. Depends on Phase 2 (needs the agent shell + tools).

**PKM facts (already mapped — trust this):** PKM is a BYOK, domain-partitioned
vault. There is an LLM-SAFE discovery surface (no plaintext): backend
`get_user_metadata` / frontend `getMetadata` return per-domain `readable_summary`
+ `readable_highlights` + `available_scopes`. `getAvailableScopes` /
`scope_generator.py:get_available_scope_entries` enumerate requestable scopes.
`buildAgentPkmContextFromMetadata` (`hushh-webapp/lib/agent/agent-pkm-memory.ts:332`)
is the EXISTING pattern for injecting PKM metadata into an agent prompt. KYC's own
domains (`kyc_workflow`, `kyc_connector`) are internal-only and read by key.

**The key architectural decision to resolve in Phase 3 brainstorming (ZK
boundary):** where does comprehension run, and what crosses the ZK line? The
incoming email is the COUNTERPARTY's text (not user PII) and PKM
readable_summaries are non-sensitive/LLM-safe — so BACKEND comprehension at
intake looks viable WITHOUT leaking user plaintext. Confirm this and design it:
LLM(incoming request + PKM availability metadata) → suggested scopes/fields to
request. Must preserve every existing ZK invariant (no plaintext PII to the LLM,
no raw body persistence — bodies are hashed today, `draft_body` stays NULL).

Please brainstorm Phase 3 AFTER Phase 2 ships (or at least after its spec), since
it depends on the agent shell.

## Workflow reminders for this repo
- Frontend: **vitest** (`npx vitest run <pattern>`, import from "vitest", use
  `it()`), separate `npx tsc --noEmit`. Backend: pytest via `uv run python -m
  pytest`. Commit with sign-off (`git commit -s`).
- SDD: fresh implementer subagent per task (model=sonnet), task-reviewer per task,
  final whole-branch review on opus. Track in `.superpowers/sdd/progress.md`.
  Scripts under the subagent-driven-development skill dir: `task-brief`,
  `review-package`.
- `main` is gated (merge queue + base-policy checks against
  `config/ci-governance.json` bypass lists; author must be in those lists). PRs
  to `main` may need admin or should target `integration/pr-train`.

Start with Phase 2: use superpowers:brainstorming to explore the design with me.
