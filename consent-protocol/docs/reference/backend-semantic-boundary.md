# Backend Semantic Boundary


## Visual Context

Canonical visual owner: [consent-protocol](../README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This document defines what must stay agent-derived and what may remain deterministic.
It is the contract `AGENTS.md` principle 9 points at. Lanes cite it; they never copy it.

## The three shapes this boundary is crossed

A deterministic validator crosses the line in one of exactly three ways. Naming them
separately matters, because each has a different fix and the first two are easy to
mistake for good engineering.

1. **Decides instead.** Host code computes an outcome the agent's own output contract
   already declares, without asking the agent. Measured 2026-09-11:
   `_should_skip_structure_agent` routes around the structure agent for
   `financial_core`, for anything requiring confirmation, and for `save_class` in
   `{ephemeral, ambiguous}` -- and "ambiguous" is precisely the case where a model
   earns its place.

2. **Discards.** The agent answered, and host code overwrites or re-derives a field it
   returned with a non-empty value. Measured on the backend, and since closed: the
   structure agent returns `action`, `externalizable_paths`, `summary_projection` and
   `sensitivity_labels`, all four `required` in its schema, and none was read anywhere.
   `_adopt_model_structure_decision` now reads all four -- `action` validated against
   the schema's own enum, `externalizable_paths` intersected with the paths that
   survived post-model payload mutation, `sensitivity_labels` merged per surviving
   path, and `summary_projection` taken from the model with only `path_count`
   recomputed, because a count is a fact about the payload rather than a judgement
   about it.

   `json_paths` and `top_level_scope_paths` stay walk-derived by design and are not a
   residual defect. `candidate_payload` is sanitized, CRUD-realigned, financially
   normalized, root-scope retargeted and metadata-stripped after the model returns, so
   model-supplied paths would describe a payload that no longer exists. Recording them
   would be a lie about what was written, not deference.

   **Current source correction, acceptance still open:** the frontend manifest
   now walks final paths and overlays reviewed `consent_label` and
   `sensitivity_label` metadata from semantic manifests and the structure
   decision (`hushh-webapp/lib/personal-knowledge-model/manifest.ts`,
   `780f96d33`). Path-derived labels remain defaults when no authored metadata
   exists. This closes the specific unconditional overwrite in source, but the
   long-paragraph reviewer acceptance and three-account encrypted-save proof
   remain separate gates; the historical 47-leaf measurement is not a current
   runtime certification.

3. **Skips.** The stage is routed around so the model is never asked. A skip must be
   recorded in the execution trace and drift flags. Until 2026-09-11 every skip site
   wrote `used_fallback = False`, which is what a SUCCESSFUL call writes, so the one
   promotion gate the live eval had read healthy exactly when the intelligence was
   absent.

**The first legitimate exception is model FAILURE.** A timeout, malformed output, or a
schema violation may be caught by deterministic code, because no agent judgement exists
to respect. A fallback reached only on failure is correct engineering. A fallback reached
on the success path is one of the three shapes above wearing the same name, which is how
`_fallback_structure_decision` came to run on both paths. It still runs on both, but for
a different reason: it is now the base walk over the FINAL payload, the only honest
description of what was actually written, and the model's own fields are adopted over it.

**The second is a data-integrity guard.** A deterministic rule may override a successful
model answer when doing so prevents an unrecoverable, one-directional loss of the
person's own record. The live case is an explicit correction cue: the intent agent
answers `no_op` to "Actually I live in New York City now", and a dropped correction
leaves someone's own record wrong with nothing to tell them it did not take. Unlike
model FAILURE this exception is narrow enough to be abused, so all three conditions must
hold and must be stated at the point the rule applies:

- it prevents a loss that cannot be undone;
- it fires on an explicit signal, not an interpretation;
- it records that it fired, so the rate is readable.

The third condition is what keeps the exception from becoming a second doctrine. A guard
whose recorded disagreement rate reaches zero has been absorbed by the instructions and
must then be deleted. `_sanitize_intent_frame` keeps exactly one rule under this
exception and gates the other five on the model not having answered; every suppressed
rule is logged by name.

Security and authority guards are not semantic decisions and are out of scope here.
Stripping a model-supplied `confirmed` flag, refusing a reserved namespace, and enforcing
consent are correct and must survive this boundary untouched.

## Canonical semantic paths

These paths must derive meaning through ADK/A2A agent stages:

- finance-sensitive routing into Kai core vs sanctioned financial memory
- PKM preview classification
- PKM manifest labelling and sensitivity, including the frontend path
  `hushh-webapp/lib/personal-knowledge-model/manifest.ts`. The boundary is not
  backend-only: a label a person reads at the moment they decide to share is a semantic
  judgement wherever it is computed.
- PKM structure planning
- future generalized user-memory interpretation
- One's composition of connected-service capabilities for a natural-language
  request. One chooses which available tools to call and in what order from
  its authored instruction and current tool catalog. Host code must not infer
  the person's intent from connector names or create pairwise semantic routers
  such as a fixed Drive-to-Gmail workflow. A typed tool adapter may validate
  arguments, pin an endpoint, enforce owner/connection authority, and refuse
  unsupported or unsafe operations. A read result never grants a subsequent
  outward action: that action needs its own reviewed recipient, payload and
  explicit confirmation through the owning service.
  Example: the owner sharing their own Drive files from chat. One stages
  `propose_drive_share` with the person and the files in the owner's words; the
  host only resolves and validates the connected person. The card runs the
  owner's own live search (the Documents planner and selector decide which
  files match), the owner ticks the exact files and taps Share, and the share
  goes through the exact-file lane under the owner's approval.

Required shape:

- manifest-backed prompt
- exact structured output
- deterministic post-validation

For One and its specialists, `AgentManifestV2` is the authored semantic layer;
generated registries and runtime prompt composition must carry that instruction
without creating a competing decision-maker. Runtime additions may state current
route facts, available tools, authorized context, and bounded presentation rules.
When those additions introduce durable semantic policy, reconcile them back to
the owning manifest and test the composed instruction so prompt copies do not
drift. This does not move consent, cryptography, or action authorization into a
prompt: those remain enforced in code.

## Deterministic support paths

These paths should remain deterministic by design:

- consent enforcement
- trust-link and token validation
- encryption and decryption
- manifest persistence
- scope persistence
- route/auth plumbing
- caching
- telemetry
- transport retries and timeouts

These are safety and infrastructure concerns, not semantic classification concerns.

## Drift and legacy paths

These paths are allowed temporarily but must be treated as migration targets or compatibility layers:

- regex or keyword domain inference
- direct Gemini semantic prompts outside manifest-backed agents
- any leftover legacy naming or storage shims influencing PKM behavior
- service-local semantic fallbacks that invent meaning

## Allowed validator behavior

Deterministic validators may:

- check contract coherence
- reject unresolved or unsafe output
- normalize storage-safe structure
- enforce no-`general` policy
- prevent finance contamination

Deterministic validators may not:

- become the primary semantic classifier
- create ontology labels the agents did not choose
- replace domain selection with hardcoded business heuristics
- overwrite, re-derive, or recompute any field the agent returned with a non-empty value
- route around an agent stage without recording the skip in the execution trace and drift flags

## Required declaration for new semantic work

Any new semantic backend feature must declare:

- owning agent
- manifest path
- structured output contract
- validator rules
- phase of live eval required before promotion

If a feature cannot provide that declaration, it is not agent-only compliant.

### Declared: first-connect insights

- Owning agent: `agent_one`, gene `one_first_connect_insights`.
- Manifest path: `consent-protocol/hushh_mcp/agents/one/agent.yaml`.
- Structured output: `FIRST_CONNECT_INSIGHTS_SCHEMA` in
  `consent-protocol/hushh_mcp/services/first_connect_insights_service.py` (`items[]` of `kind`,
  `label`, `memory_text`, `evidence`).
- Validator: `validate_insights` rejects an item whole (unknown kind, empty or
  over-long text, an email address) and caps at five; it never rewrites a field.
  A model failure is recorded as `failed` and retried after an hour.
- Live eval before promotion: none yet. Mocked contract tests only; extraction
  quality on real mailboxes and calendars is unmeasured.

### Declared: explicit memory save from chat

- Owning agents: `agent_one` decides that the person asked to save (tool `add_to_pkm`,
  with `whole_message` for a pasted document); `agent_memory_segmentation`,
  `agent_memory_intent`, `agent_memory_merge` and `agent_pkm_structure` decide what the
  facts are, where they go, and whether each creates, extends or corrects. Manifests under
  `consent-protocol/hushh_mcp/agents/`.
- Structured output: the existing `POST /api/pkm/memory/proposals` preview cards.
- Host policy (`hushh-webapp/lib/agent/agent-pkm-explicit-save.ts`) enforces authority only.
  The owner's request is the confirmation for the content they supplied, so a card the
  agents marked `confirm_first` is written with an `owner_confirmed` receipt. It never
  changes a card's domain, path, payload or merge mode. It holds back, for the owner's
  direct tap, a card whose payload has an identifier-class key or value
  (`contracts/consent/field-sensitivity.v1.json`) or whose save would change what the owner
  already shares, and it never writes a reserved, degraded, secret or `do_not_save` card.
- Reconciliation context, not a decision: for each section the device offers up to ten
  of the owner's existing entity summaries chosen by local word overlap
  (`AgentPkmContextStore.findReconciliationCandidates`) as `simulated_state.memories`.
  The merge agent alone decides create, extend, correct or no_op. A `no_op` that names
  the stored entity it matched is reported as already known; the host never
  re-derives a merge mode.
- Display only: `classifyMergeOutcome` (`hushh-webapp/lib/pkm/pkm-supersede-merge.ts`)
  labels each acknowledged write as new, updated, merged or already known from the stored
  state the write merged into. It decides nothing about meaning.
- The KYC keyword route `isExplicitKycIdentitySaveRequest` predates this contract. It is
  narrowed to a single short section (at most 1,200 characters) so it can no longer take a
  whole document away from the semantic agents (production, 2026-09-29).
- Live eval before promotion: the synthetic context-transfer run recorded in
  `personal-knowledge-model.md`; mocked contract tests in
  `hushh-webapp/__tests__/services/agent-pkm-explicit-save.test.ts`.

### Declared: consent scope catalog search (contract C4)

Keyword and synonym matching in `consent-protocol/hushh_mcp/consent/scope_matcher.py`
would sit on the drift list above. It is declared, and scoped, as catalog search:

- Owning agent: `agent_one`, tool `propose_information_request`; manifest
  `consent-protocol/hushh_mcp/agents/one/agent.yaml`. The same ranker backs
  `GET /api/one/people/{person_ref}/scope-catalog`.
- Scope: it ranks the owner's requestable catalog by human labels, domains and a small
  synonym table. It never sees a value and never decides intent; the model does.
- Never overrides the model: the model's own words are matched first, verbatim. Search
  only resolves words that named nothing, then the question only if nothing matched.
- Explainable: every pick carries a `why` shown on the ask card, and a no-match fallback
  is offered as a suggestion to change. The person's tap on Send is the decision.
- Never picks storage shape: a record's schema field (`kind`, `status`, `summary`,
  `observations` below `_entities` or `_items`) or app state (`parse_fallback`) is never
  preselected (`is_proposable_entry`). The catalog a person reads drops those rows when a
  branch row covers them and shows one row per human label (`presentable_scope_entries`);
  request validation still uses the full catalog. Measured 2026-09-28: "What's Kushal's
  favorite restaurant?" proposed "Kind".
- The reason is the model's: One writes it from the question (`purpose`, for example
  "To pick a restaurant for dinner"). Only an empty one is filled by host code, from the
  person's own words and never from a catalog label, and the result records it as
  `reasonSource: "fallback"` (`agent` otherwise) with the log line
  `one.proposal_reason_fallback`.
- Live eval before promotion: none yet. Deterministic ranking tests only
  (`consent-protocol/tests/test_scope_search_ranking.py`).

### Declared: conversation history titles

- Owning agent: `agent_one`, tool-free gene `one_conversation_title` in
  `consent-protocol/hushh_mcp/agents/one/agent.yaml`.
- Output: `ConversationTitles` in `hushh_mcp/one_adk/conversation_titles.py`;
  one unique supplied reference and complete title per untitled conversation,
  at most 32 characters and six words. Validators reject invalid labels rather
  than truncating or substituting semantic text.
- The owner-authenticated history listing supplies only opening user text under
  the live chat key. Thoughts, assistant answers, shared information, and tool
  results are excluded. One bounded model call repairs at most 20 visible chats.
  Titles remain encrypted in `hussh:thread_summary_title`; manual
  `hussh:thread_title` takes precedence. Revision checks protect concurrent
  renames/messages; automatic titles preserve conversation recency.
- Failure: content-free outcome logs, opening-text fallback, and a bounded
  process-local 60-second retry cooldown. Empty conversations use `New chat`. Disable with `ONE_CHAT_TITLE_SUMMARIES_ENABLED=false`.
- Surfaces: existing web/iOS/Android chat history response; no voice, A2A, MCP,
  external tool authority, or PKM mutation is added.
- Evaluation: mocked contract tests cover privacy, bounded output, persistence,
  races, and failure. A live synthetic check produced “Tech and biology
  background” and “Writing my bio”; real-owner content must not enter evaluation logs.

### Declared: One Voice Mail analysis

- Owning agent: the Email specialist under One Voice. One selects the existing
  `read_mail` tool; `agent_email_read_planner` selects `analyze_mail` and the
  requested categories from the owner's current question. The existing
  `agent_email_request_classifier` judges personal-information requests;
  `agent_email_read_analyzer` extracts action items and mail-derived meetings.
- Manifest path: `consent-protocol/hushh_mcp/agents/email/agent.yaml`.
- Structured output: `MailReadPlan` (`operation`, bounded Gmail query and limit,
  `categories`) and `MailAnalysisAnswer` (`findings` with category, source ref,
  update refs, detail, state, and zoned due/event time) in
  `consent-protocol/hushh_mcp/services/email_delegated_read.py`. The personal
  classifier retains `EMAIL_REQUEST_CLASSIFIER_SCHEMA` in
  `consent-protocol/hushh_mcp/agents/email/runtime.py`; its nonpersisting service
  assessment returns a boolean and registry-authored field names.
- Validator: the reader caps analysis at 12 message bodies, keeps provider IDs
  server-side, and reports partial coverage. The service accepts only requested
  categories and refs from that read, requires each update ref to come from the
  same retrieved thread, and rejects naive or malformed event/due times. A
  failed category remains unavailable, never zero findings. The Live model sees
  only code-counted coverage; Mail text and findings are screen-only. No phrase
  table selects an operation, and analysis neither mutates Mail nor checks the
  owner's Calendar.
- Live eval before production promotion: run a consented UAT session on an owner
  mailbox with positive and negative personal-information requests, an action
  item with a later completion, and an invitation with a later cancellation or
  reschedule. Verify the bounded search scope, source and Open bindings, correct
  timezone, partial-category failure, and the continuous One Voice conversation
  across in-app navigation. Synthetic contract tests prove the safety boundary;
  they do not establish classification accuracy on a live mailbox.
