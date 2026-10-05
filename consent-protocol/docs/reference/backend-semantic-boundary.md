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
   `_should_skip_structure_agent` routed around the structure agent for
   `financial_core`, for anything requiring confirmation, and for `save_class` in
   `{ephemeral, ambiguous}` -- and "ambiguous" is precisely the case where a model
   earns its place. Closed in Phase 4 of the reserved-branch plan: the structure agent
   is skipped only when the intent agent itself answered `no_op` or `command`, the
   keyword-routed Financial Guard stage is gone, and a statement needing confirmation is
   structured instead of clipped by the fallback record.

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
  changes a card's domain, path, payload or merge mode. Sensitive details (pay, equity,
  immigration, a housing deposit) are saved, labelled sensitive. It holds back, for the
  owner's direct tap, a card whose payload still carries a raw identifier: an
  identifier-shaped value, or an identifier-class key (`contracts/consent/field-sensitivity.v1.json`)
  with a digit-bearing value, other than the entity's own `entity_id`. A Secrets placeholder
  (`⟦secret:<id> <label>⟧`) is a reference, never an identifier. It also holds a card whose
  save would change what the owner already shares, and it never writes a reserved,
  degraded, secret or `do_not_save` card.
- Reconciliation context, not a decision: for each section the device offers up to ten
  of the owner's existing entity summaries chosen by local word overlap
  (`AgentPkmContextStore.findReconciliationCandidates`) as `simulated_state.memories`.
  The merge agent alone decides create, extend, correct or no_op. A `no_op` that names
  the stored entity it matched is reported as already known; the host never
  re-derives a merge mode.
- Display only: `classifyMergeOutcome` (`hushh-webapp/lib/pkm/pkm-supersede-merge.ts`)
  labels each acknowledged write as new, updated, merged or already known from the stored
  state the write merged into. It decides nothing about meaning.
- The KYC keyword route `isExplicitKycIdentitySaveRequest` is retired (reserved branches,
  Phase 1). It once sent a 17,120 character paste to the KYC extractor as one call
  (production, 2026-09-29). An explicit save now always goes to the semantic agents; the
  KYC writer runs only for a typed reply to an owner-selected information request, bound
  to that request by a server-issued capability.
- Live eval before promotion: the synthetic context-transfer run recorded in
  `personal-knowledge-model.md`; mocked contract tests in
  `hushh-webapp/__tests__/services/agent-pkm-explicit-save.test.ts`; the recorded
  founder-shaped document in `consent-protocol/tests/services/test_context_transfer_is_kept.py`
  and its replay through the save job in `hushh-webapp/__tests__/services/pkm-save-job.test.ts`.

### Declared: keeping everything the owner stated (Phase 4)

- Owning agents: `agent_memory_segmentation` selects every stated claim with
  `context_quotes` and accounts for every other line in `not_memory {quote, reason:
  duplicate | disclaimer}`; `agent_memory_intent` alone decides memory versus a live
  `command`; `agent_pkm_structure` chooses a domain for everything or the reserved sibling.
  The Financial Guard Agent and its keyword fallback were removed.
- Validator, normalize only: `locate_source_quote` maps each quote onto the owner's exact
  text, folding Markdown emphasis, heading and code marks, dash and quotation-mark variants
  and whitespace on both sides; the stored quote is always the ORIGINAL span. A quote that
  matches nothing is dropped alone and counted (`unmatched_quote_count`,
  `segment_quote_unmatched`); the device shows its lines as "not yet saved". It no longer
  discards the whole section.
- Validator, recorded substitution: a model target named after a protocol namespace a
  person could mean as a subject (`agent`, `agents`, `mcp`, `system`) is kept in the intent
  agent's recommended domain, or `professional` when that is unusable, nested under the
  name the model chose, and recorded as `protocol_domain_name_remapped`. The structure
  instruction already forbids those names, so the hint's rate measures instruction
  disagreement. Storage and authority namespaces stay refused.
- Skip rule: the structure agent is skipped only for an intent `no_op` or `command`,
  recorded as `structure_skipped`.

### Declared: reserved branches in PKM structure planning

- Owning agent: `agent_pkm_structure`. Its system instruction
  (`consent-protocol/hushh_mcp/agents/pkm_structure/agent.yaml`) states the rule: an
  app-owned branch is never a target; the fact goes in that branch's `agent_memory`
  sibling with `reserved_offer {branch, label}`. Each request carries the table from
  `contracts/pkm/reserved-branches.v1.json` (`reserved_table_for_prompt`).
- Structured output: `_STRUCTURE_PREVIEW_SCHEMA` gains the optional `reserved_offer`.
  Preview cards carry `reserved_offer {domain, branch, owner_feature, agent_memory_sibling,
  offer_action {route_pattern, action_id, label}, registry_version}`; the chat renders it
  as an offer to commit the fact on the owning app's screen.
- Validator: authority, not meaning. After the model answers,
  `_reroute_reserved_payload` checks every payload path against the registry. A path
  still inside an app-owned branch is moved to that branch's sibling and recorded as
  `reserved_target_rerouted_to_sibling` (validation hint and drift flag); it is never
  silent and never a general domain. A branch with no sibling (KYC internals, runtime
  credentials, Secrets) or a correction or deletion of an app-owned record is
  `do_not_save` with `reserved_branch_blocked` or `reserved_target_offered_not_saved`.
  The validator chooses no domain and no meaning the registry does not name. It replaced
  `_touches_source_managed_financial_branch`, which saw Finance top-level keys only.
- The rate of `reserved_target_rerouted_to_sibling` measures how often the instruction
  and the registry disagree. When it reaches zero, the move is absorbed by the
  instruction and becomes a pure refusal.
- Live eval before promotion: none yet. Mocked contract tests in
  `consent-protocol/tests/services/test_pkm_agent_lab_service.py` (RIA, Wallet, Finance,
  and an unreserved negative control).
### Declared: owner standing style settings

- Owning agent: `agent_one` decides whether the owner stated a lasting writing
  preference and calls `propose_style_settings`
  (`consent-protocol/hushh_mcp/agents/one/agent.yaml`). No keyword or regex route
  detects a style request.
- Structured output: the tool's `proposed` object, closed to `preferred_name`,
  `tone`, `length`, `language` and `avoid_em_dashes`
  (`hushh_mcp/one_adk/owner_style.py`). Chat cannot propose `owner_style_note`.
- Validator: `validate_owner_style` refuses unknown keys, wrong types and oversize
  values (400 on the chat route, `invalid` from the tool); it never clips or
  substitutes a value. Sanitizing removes control and format characters only.
- Authority: none. The tool writes nothing; the owner commits in Settings. The
  prompt section is rendered from server templates, owner text is a quoted
  literal, and no tool gate reads the style state
  (`tests/test_one_owner_style.py` asserts unchanged authorization decisions).
- Live eval before promotion: none yet. Mocked contract tests only; whether One
  follows each template turn after turn is unmeasured.

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


### Declared: typed-chat message reactions

- Owner: One, `react_to_message` in `hushh_mcp/agents/one/agent.yaml`.
- One chooses an optional contextual emoji during its normal turn. Host code
  only validates the allowed single emoji, typed-chat surface and once-per-turn
  limit; no keywords classify emotion. Vulnerable news is instructed to use 💛.
- The model accepts only emoji, never a target ID. Joined messages use the
  server-owned queued-input reference; ordinary turns use the captured client
  user message. No consent, feed or external action authority is added.
- AG-UI carries the ordinary tool result. The tool never ends the turn.
  Reaction calls/results are removed from the sealed session projection and
  remain live-session presentation only; no history badge restoration or logging.
- Validation: real ADK/AG-UI scripted-model contract, sealed-history exclusion,
  client parsing/deduplication and exact user attachment. Live semantic quality
  is not established by scripted tests and requires authenticated evaluation.

### Declared: One Voice scheduled send time

- Owning agent: the One Voice Live head. It selects `schedule_mail` over
  `send_mail` when the owner names a later time. It resolves a clock time or a
  day ("kal subah", "tomorrow at 9", "next Friday") into an owner-local
  wall-clock `send_at`, using the current time and the owner's zone that
  `build_instruction` states in the system instruction, and a duration ("in 30
  minutes") into `send_in_minutes`, which the server counts from its own clock.
  Host code never parses natural language and never picks a time.
- Manifest path: the tool declarations in
  `consent-protocol/hushh_mcp/one_voice/tools/mail.py` (`schedule_mail`,
  `list_scheduled_mail`, `cancel_scheduled_mail`; the 9:00 AM defaults live in
  the `schedule_mail` description) and narration rule 13 in
  `consent-protocol/hushh_mcp/one_voice/instruction.py`.
- Structured output: exactly one of `ScheduleMailInput.send_at` (string,
  owner-local wall-clock ISO-8601 without a UTC offset, e.g.
  `2026-10-06T09:00:00`; the server applies the owner's zone, daylight saving
  included, and still accepts an explicit offset) and
  `ScheduleMailInput.send_in_minutes` (integer, 2 to 43200). Neither or both is
  refused with a spoken question (`schedule_time_missing`,
  `schedule_time_ambiguous`), never resolved by host code.
- Validator: `owner_time.resolve_send_at`, `send_at_after_minutes` and
  `check_send_at` only accept or reject. They refuse an unparseable or worded
  time, a time already past, one less than 60 seconds out, or one more than 30
  days out, each with a typed reason and a spoken question. They never round,
  roll or rewrite a time. The confirmation card repeats the stored instant in
  owner-local words ("tomorrow at 9:00 AM IST") as the human check. The yes
  re-validates that instant against the server clock; a duration's instant is
  pinned at the card and never counted again.
- Live eval before production promotion: the mail tool-selection eval's
  `schedule` family (later time is `schedule_mail`, never `send_mail`; no time
  is `send_mail`) sampled several times per case on the UAT Live model, plus a
  consented UAT session that schedules a near-future send, lists and cancels
  one, and lets one fire through the drain.
