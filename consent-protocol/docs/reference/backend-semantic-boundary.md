# Backend Semantic Boundary

### Declared: recipient-requested Finance object review

`one_adk/finance_share_context.py` admits an explicit recipient-selected curated
Finance view into One's existing shared-information turn. The model owns the
explanation and assessment; the host does not compute a recommendation or return
a canned analysis. Deterministic support validates exact participants, approved
sections, amounts, independent owner model permission, revision/digest and current
grant lifetime. No tools or memory writes run from that shared-context turn.
`consent_continuation_instruction` contributes the current source and bounded
presentation facts to the existing manifest-backed One instruction; it creates
no additional router or agent. Revocation, expiry, unavailable authority and
revision changes remove derived context/history through the existing consent
redaction owner. The post-generation guard records `one.finance_review_access_ended`
when it suppresses a result because current authority was lost. No fallback
model assessment is substituted.


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
- typed-chat draft recipients: One decides to write an email and passes a named
  person in `recipient_names` or `cc_names`; `one_adk/email_draft_recipients.py`
  matches that name against the owner's active connections with the shared
  spoken-name rule. It never guesses: it addresses the draft only when exactly
  one connection matches and the name as said is that connection's whole name
  or whole words of it; a display name holding an address never counts as a
  name. A partial or misspelled match, several matches, people sharing one name,
  or an unknown or address-less name opens no draft and returns a typed status
  whose message names the one question One asks. Names resolve only for a
  typed-chat app that declares draft contract 2 (`forwardedProps.emailDraftContract`);
  an older installed app shows the call's own recipients, so
  `one_adk/email_draft_tool.py` refuses names for it with
  `recipient_address_required` and One looks the address up with
  `list_my_connections` (a refusal, never a substituted recipient). When two to
  four connections match a To name, the question also carries `choices`
  (`{ref, name}`, never an address), so the owner's "both" or "all" is One's
  decision expressed as the refs it passes in `recipient_choices`; refs address
  To only, so a Cc or Bcc name keeps its address question. A ref is an
  owner-bound hash of the connection (`one_adk/email_draft_choices.py`),
  checked by recomputing it over the owner's current connections and never
  stored; an unknown ref is `recipient_choice_expired`, and refs never single
  out one of several connections that share a name (that still needs its
  address). A name its chosen refs answer is not asked again.
- model-request history: before each One model call,
  `output_privacy.drop_replayed_tool_placeholders` keeps stored placeholders out
  of that outgoing request only: an earlier read, draft or receipt call whose
  stored result is `content_redacted` (its arguments emptied), an earlier private
  receipt answer, a call that never got its result and an Azure reasoning item
  left without the call or answer it preceded. Replayed, the model copied `ask_email_agent({})` for every
  later mail request (UAT, 2026-10-29). Stored history keeps its redaction. Each
  request that loses parts logs `one.history_hygiene removed=<n>`, a count only.

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

### Declared: One public-search final answer

- Owner: One; `hushh_mcp/agents/one/agent.yaml` authors when the existing isolated
  `google_search` child may complete the entire public request unchanged.
- Output: the tool declaration exposes `request: string` and optional
  `finish_turn: boolean`. Only explicit `true` requests delegation; omission,
  false and unsupported search transports retain ordinary root synthesis.
  The declared short-answer choice uses compact LOW native search context on a
  local child/model copy. An administrator-declared `compact_public_search`
  descriptor may select the separately qualified Azure deployment and its NONE
  reasoning budget for that copy. The same selector is exercised by required
  pre-promotion capability qualification; citation or public-fact failure blocks
  admission. Ordinary/deeper research, the root and concurrent calls keep their
  original configuration. The host never guesses research depth.
- Validators in `one_adk/search_answer.py` admit only fresh grounded completed
  output, the invocation's sole tool call, no earlier visible answer or pending
  review, current managed owner authority and an atomic empty-input finish.
  They never classify the request, rewrite the child's answer or authorize an
  action. Stop, revocation, failures and competing input prevent publication.
- The exact answer and grounding become one ordinary One assistant event;
  `one_delegated_search_answer_v1` and content-free saved-call telemetry expose
  the removed synthesis stage. No transcript is placed in handoff state.
- Eligible public-answer drafts may stream through a request-local observer and
  bounded ADK queue. One still owns the explicit finish decision. Before the first
  visible delta, an atomic empty-inbox cutover reserves final-answer publication;
  earlier pending input keeps ordinary continuation and later input returns for
  the next turn. Draft text grants no citation, action or completion authority.
  Final receipt/billing checks and exact post-callback text parity remain
  mandatory. Failed drafts retain the existing error notice and never become a
  completed history answer. Every actual publication rechecks authority and Stop.
- Live eval: before promotion, measure public-only synthetic Azure calls against
  the serving model; after UAT promotion, require authenticated HTTP search,
  citations and same-chat continuation, joined to the serving revision's logs.
  Offline AG-UI regression and negative controls protect history, authority,
  queued-input and completion accounting. No browser or vault fixture mutation
  is required. Rollback selects the prior application revision.

### Declared: One task suggestions

- Owner: One's internal `one_todo_suggestions` child in
  `hushh_mcp/agents/one/agent.yaml`; the existing single-turn ADK builder executes
  it with no tools/history. No separate router or copied provider prompt.
- Output: `TaskSuggestions` in `hushh_mcp/services/one_todo_suggestions.py`.
  The gene decides whether a supplied summary supports a useful next step and
  authors `source_ref`, `title`, and `reason`, or returns an empty list.
- Validators enforce strict types, input/output lengths, at most 100 inputs and
  12 outputs, unique offered source references, explicit processing approval,
  current self-owner authority, Shared placement and the default-off kill switch.
  They never infer semantic tasks, rewrite model text or substitute a fallback.
  Source inventories project explicit pending work under existing service
  contracts; summary selection by the model does not prove provider completeness.
- Persistence remains the existing owner-confirmed encrypted `one_todos` Add
  action. Suggestions are ephemeral; no provider action is executed. Client
  owner/session fences suppress late results. Private placement refuses Shared
  processing. Failures emit status-only stage telemetry and return a retryable
  unavailable response, with no semantic substitution.
- Live eval before promotion: run the authored gene on synthetic summaries for
  each visible capability, no actionable evidence, already-pending items,
  untrusted instructions, ambiguous evidence and forbidden financial advice.
  Require valid grounding, no duplicate/newly invented obligations, no sensitive
  output, no unsafe advice, meaningful abstention and bounded latency across
  repeated runs. Unit tests prove validators/authority only; the default-off
  rollout is not qualified until live model and real-provider rehearsals pass.

### Declared: Drive request package assessment

- Owner: the existing Documents `agent_documents_suggestions` gene, with explicit
  `document_assessment` and `package_assessment` task modes in
  `hushh_mcp/agents/documents/agent.yaml`; no parallel router or direct model prompt.
- Output: `DocumentBatchAssessment` and `PackageAssessment` in
  `hushh_mcp/services/drive_request_package_assessment.py`. The gene decides
  relevance, content periods, inclusion, coverage, confidence (0–100 assessment,
  not a probability), importance (1–500) and editable estimated USD cents (50–50000).
- Validators check supplied document identity, exact same-document quotation,
  source references, provider-version binding, calendar validity, bounded context,
  typed money, and consistency with explicit truncation/unreadable evidence. They
  reject invalid output; they never invent relevance, substitute prices, approve
  sharing, or treat the model's confidence as measured accuracy. The caller owns
  consent, current provider versions, request revision and exact package approval.
- Live eval before promotion: `scripts/eval_drive_package_assessment.py --reps 3`
  uses 12 synthetic gold-labeled cases, both real model stages and 36 repetitions.
  Every exact document/package decision and money bound must pass, with zero
  false acceptance or missing expected included file. It reports abstention,
  precision, recall, latency and errors. Mock tests and model self-confidence do
  not satisfy that gate. This is bounded synthetic evidence, not a calibration,
  production-corpus recall measurement or empirical market-price validation.

### Declared: deterministic Drive request search terms (owner decision)

- Decision: on 2026-10-17 the org admin and product owner removed the Gemini
  request planner from the Drive request flow, because the shared Gemini quota
  is repeatedly exhausted and paused. This is a recorded **skip** of the
  `agent_documents_live_search` stage, not a silent substitution.
- Replacement: `hushh_mcp/services/drive_request_brain.py` turns the request
  phrase into Drive discovery literals (typed words, a document-type synonym
  lexicon, plural/singular forms, an owner-vocabulary spelling hint, date
  phrases inside the picked dates removed as an advisory period, and
  head-of-phrase kind words as MIME kinds). It is also the title-evidence
  rule for automatic sharing, so that rule is deliberately narrow: only the
  words the requester typed, their plural/singular forms and exact synonyms
  ("pay slip" for "payslip", a cased "MoM") count. Loose lexicon clues
  ("salary", "call", "card", "premium") and owner-vocabulary spelling fixes
  only discover candidates for owner review. A request with no subject word
  fails closed (`narrow_selection_required`) unless it explicitly asks for a
  listing. The picked request dates, kind fences and
  `drive_request_review_policy` still decide what may be shared.
- Record: every plan freezes `request_plan_source` (`deterministic_brain` or
  `model`) and the brain's concepts in the encrypted search checkpoint, and the
  planner logs `drive_request.plan source=deterministic_brain` with counts only.
- Rollback: `DRIVE_REQUEST_GEMINI_PLANNER_ENABLED=true` restores the
  manifest-backed planner (default off); its model-failure fallback stays
  recorded in `planner_fallback`.

### Declared: Drive four-group organizing aid (owner decision)

- Decision: on 2026-10-21 the owner chose to sort a person's Drive files onto four
  virtual shelves with no model that writes text, for the same quota reason as the
  2026-10-17 decision above. This is a recorded **skip** of the Documents gene's
  judgement for this one surface, not a silent substitution, and it is a bounded
  aid in the manner of the scope-catalog ranker (C4), not a classifier of record.
- Owner: the Documents gene (`agent_documents_suggestions`,
  `hushh_mcp/agents/documents/agent.yaml`) stays the semantic owner of what a
  document means; this manifest is unchanged. The aid in
  `hushh_mcp/services/drive_groups/` only places a file's index entry on a shelf:
  `financial_statements`, `non_financial_statements`, `insurance_statements`,
  `personal_documents`, or `kept`. It reads the first few hundred characters of the
  owner's own file under the owner's live grant, in memory, through the existing
  fenced `read_file_content` read and isolated parser. Its definitions of the four
  groups are data in `drive_groups/data/groups.json`, not code.
- Output: `Placement` in `drive_groups/contract.py`: `group` (None when kept),
  `candidate`, `best_class`, `confidence` (a Platt-calibrated score fitted on labelled
  fixtures, not a measured accuracy), `margin`, a closed `reason`, the three signal
  readings, the data `version` and `group_source = organizer_v1`.
- Authority: none. A placement grants no sharing, consent, search or reading
  authority and never writes to the person's Google Drive. A file below the
  confidence, margin or agreement thresholds is kept, with its text start and
  embedding retained for future indexing; it is never dropped and never guessed.
  A label from the Documents gene or the owner's own move wins over `organizer_v1`,
  and the rate at which they disagree is the measure of the aid; when an agent
  label replaces it, the aid is deleted.
- Validators: every number in the data files is checked on load (finite, bounded,
  closed class list, unit-length vectors, non-negative weights). The weights,
  calibration and thresholds are fitted offline by
  `consent-protocol/scripts/train_drive_groups.py` and never edited by hand; a
  signal the fit found no use for gets weight 0 and casts no vote. Logs carry
  counts and closed labels only: no name, text start or file ID.
- Rollback: `DRIVE_FOUR_GROUP_INDEX_ENABLED` (default off). With it off the aid
  refuses to run (`GroupIndexDisabled`) and nothing is placed.
- Live eval before promotion: `consent-protocol/scripts/eval_drive_groups.py`.
  On the 146 held-out synthetic files (template families the fit never saw) the
  refit `33f7631e3696` placed 85, all correctly, placed none of 50 unrelated
  files and kept 11 of 96 group files (previously 55 correct and 2 unrelated
  placements). The original evaluation rows are unchanged; the repair used this
  benchmark diagnostically. Those are invented documents: a regression
  gate, not accuracy on a real Drive. Accuracy evaluation needs the same script run by the
  owner on authorized real labels (`--fixtures` with a private file, counts only),
  meeting the precision target, reported with per-class counts. The owner has
  separately authorized the UAT organizing-aid rollout; that authorization does
  not turn synthetic precision into measured real-file accuracy. Unreadable
  prefixes and ordinary media remain kept; metadata never replaces content.

### Declared: historical request-local semantic Drive search (policy v1)

- Owner: Documents `agent_documents_request_search` plans a
  `SemanticLiveSearchModelPlan` independently of the legacy live-search
  instruction; its `semantic_query` is a strict versioned disjunction of
  conjunctions. Documents `agent_documents_request_assessment` assesses candidates through
  `generic_request_candidate_v1`. Both instructions live in
  `hushh_mcp/agents/documents/agent.yaml`; no service-local semantic prompt or
  lexical substitute participates in this policy.
- Admission: only new UAT requests seal `semantic_search_policy_version=1`.
  `DRIVE_REQUEST_SEMANTIC_SEARCH_ENABLED=false` stops new enrollment. Historical
  and refunded requests keep their original contracts. This supersedes the
  October 17 deterministic-planner decision only for the enrolled cohort.
- Host validation: validate and escape the complete interpretation, retain
  provider content hits independently of filenames, and assess a durable bounded
  candidate queue under the existing search lease. Only source-bound positive
  observations commit as eligible results. Unresolved identities require input;
  model/provider failure remains unavailable; incomplete reads cannot establish
  an exhausted empty result. Scores and spelling clues grant no authority.
- Failed output may receive one bounded correction using only schema-owned
  field locations, error types and closed evidence-integrity rules. A transient
  provider failure retries the same prompt, without semantic correction feedback.
  Both assessor attempts share the original model deadline and recheck current
  authority; a valid exclusion or uncertainty is never retried to change its meaning.
- Source, request revision, connection generation, original purpose, plan digest
  and assessment-policy digest bind encrypted evidence. The permission worker
  checks the assessed provider version, current consent and payment separately.
  Requests start at revision `0`; candidate evidence preserves that exact
  nonnegative revision. Positive review revisions remain a separate contract.
  Selected dates retain title → created → modified precedence by default;
  explicit created/modified or content-period intent remains distinct.
- Promotion evidence: production-function regression tests plus the opt-in
  `consent-protocol/scripts/eval_drive_semantic_request.py` exercise independently labelled
  synthetic planner and assessor cases. Report all-attempt precision/recall,
  abstentions, errors and latency. These checks do not prove complete Google UI
  parity, OCR accuracy on arbitrary originals or production-corpus recall.

### Declared: activity-date query-and-list Drive requests (policy v4)

Documents `agent_documents_request_search` is the sole semantic stage. Its
host-selected semantic-plan-v2 output expresses bounded executable concept
alternatives and explicit entity-only sparse fallback permission. Python validates,
escapes and freezes native queries; it does not infer replacement concepts or
reassess provider matches. Native retrieval is followed by the versioned
`drive_activity_union_v1` deterministic date gate before durable commit and sharing.
Explicit quotations, filename/account constraints, exclusions and created-only or
modified-only meaning remain intact. Bounded retries remain retries of this same
planner. No content/OCR/extraction/indexing or second model enters this path.

Historical policy readers and V1 digests remain unchanged; existing paid/approved
membership cannot be reinterpreted without a new request revision. The activity
union is file-event eligibility, not content-period proof. See
[the operational contract](./drive-continuous-packets.md#activity-date-search-match-delivery-policy-v4)
for limits, evidence, diagnostics, adoption, recovery and rollback. Synthetic
planner evaluation proves only its observed bounded cases, not Drive UI parity
or production-corpus recall.

### Declared: Continuous Drive evidence and reusable packets

- Owner: existing Documents `agent_documents_suggestions` gene in
  `hushh_mcp/agents/documents/agent.yaml`; modes `page_facts`, `document_facts`,
  `canonical_packet`, and `packet_verification`. Request matching retains its
  existing document/package modes. No keyword router decides relevance.
- Output: `DocumentPageFacts`, `DocumentFacts`, `PacketAssessment`, and
  `PacketVerification` in `services/drive_packet_contract.py`. Meaning, canonical
  grouping, coverage, importance and suggested prices remain model decisions.
- Validators account for every supplied page, exact page/unit quotation,
  source/facts versions, complete processing, bounded context and approved
  identities. Consolidation cannot invent citations; unfinished evidence cannot
  be ready. A simpler provider JSON grammar avoids measured Vertex complexity
  errors; all original Pydantic limits still apply to returned output.
- Live evaluation: original PDFs, including image-only scans, through real OCR,
  fact extraction, request selection and a separate runtime verifier using
  `consent-protocol/scripts/eval_drive_pipeline.py` and
  `consent-protocol/scripts/drive_pipeline_model_adapter.py`.
  Independent fixture labels never enter model inputs. Preserve every failure,
  report all-attempt denominators, model/prompt/schema/extraction versions and
  latency. Synthetic results are a regression gate, never the 99.9% proof.
- Permission and commerce: explicit collection processing consent is separate
  from summary publication and exact buyer approval. Existing purchase/delivery
  workers retain authority. A runtime checker is not an independent gold label.

### Declared: Soul.md reconciliation profile

- Owners: existing Memory Segmentation, Intent, Merge and PKM Structure agents;
  manifests in `consent-protocol/hushh_mcp/agents/{memory_segmentation,memory_intent,memory_merge,pkm_structure}/agent.yaml`.
- Output: existing stage schemas; Soul structure payload contains exactly
  `soul_text` (complete attributed fact) and `soul_section` (Facts, Preferences,
  Commitments). Merge owns create/extend/correct/delete/no-op and exact targeting.
- Validators reject unknown targets, oversized snapshots, invalid payloads,
  credential material and export paths; they never select a replacement target
  or rewrite a successful model's fact. Skipped no-op stages remain traced.
- The browser validates the offered bullet again before RAM mutation and cloud
  CAS. Masked or ambiguous targets are refused rather than partially replaced.
- Promotion evidence: synthetic full-pipeline/negative-control tests are the UAT
  contract gate; owner verification of live correction, deletion and attribution
  is required before claiming live-model quality or production readiness.

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

### Declared: Magic Intelligence

- Owning agent: `agent_one`, bounded task `one_profile_research`; its existing
  `google_search` child supplies public evidence. No new top-level router.
  Magic Intelligence researches the owner's public personal profile after
  onboarding; business information is optional.
- Manifest path: `consent-protocol/hushh_mcp/agents/one/agent.yaml`.
- Structured output: `ProfileReport` in `hushh_mcp/one_adk/profile_research.py`;
  match status, name, concise summary, up to four sections and eight facts per
  section, each with confidence and HTTPS source links.
- Single-shot discovery: `run_profile_discovery` calls the existing grounded
  research task once with all available full owner identifiers. The separate
  `one_profile_verify` agent, score computation and numerical release gate are
  removed. The researcher owns match status, statements, summary and categorical
  source uncertainty; the host validates source/schema/authority without
  upgrading meaning or forcing a match.
- Execution is bounded to one 160-second discovery deadline and one Search child
  call (up to three logical model calls). There are no query permutations or
  automatic research retries. Existing 200-second jobs, key/lease limits and the
  three-start/hour admission limit remain unchanged.
- The child request preserves the owner's name, full verified email and full
  verified phone together, unchanged and JSON-quoted. Missing fields stay missing.
  Native Google grounding may reformulate its internal queries, as authorized;
  received grounding/source references remain required, but literal query
  receipt matching is not an acceptance condition. No private-account tools,
  caller-selected identities, PKM authority or sharing grants are added.
- Profile retrieval intent is authored in the existing Search child's manifest,
  so an exact identifier-only child request still asks for roles, education,
  projects and public activities. Identifiers are anchors, not a mandatory
  conjunction or a requirement for contacts to be published. A coherent cited
  candidate without a secure owner link remains uncertain; missing public
  contacts alone must not turn findings into no-match. This is agent guidance,
  not a host-side override of the report or a second confidence stage.
- The sole research slot is charged before provider dispatch under revision and
  ciphertext CAS. Interrupted or failed charged tasks cannot replay it for the
  same identity/policy/window. Failures return terminal unavailable without
  invented confidence or no-match evidence. Old seven-mask and scored checkpoint
  states are recognized only during migration: a changed policy binding prevents
  their release, preserves paid-start history, and admits one new-policy slot.
  Frontend decoders retain old metadata compatibility, never a current score gate.
- Raw compatibility Search strategy: the authored task starts with the public name, using an
  organizational email domain only as a hint. It keeps full email/phone as
  private matching context, without requiring a public contact match. At most
  one follow-up fits the existing five-call/160-second task budget: broader
  targeted public-name recovery for an unmatched first pass, or focused missing education,
  projects, competitions, leadership and achievements after a credible match.
  The model chooses queries and facts; host code does not fabricate coverage.
  Attendance, organization and winning are distinct, historical sources do not
  establish current roles, and duplicate facts belong in one section only.
  Namesake candidates remain separate; a report contains one coherent person,
  not unrelated candidates relabelled as uncertain. Occurrence lists and
  answer-site assertions alone cannot establish biographical claims.
  Search calls run sequentially so each attempt carries only its own receipts;
  the host rejects parallel tool calls and more than two Search attempts.
  The tool result exposes whether Search execution was observed; a refusal
  cannot be treated as proof that a profile does not exist.
- The internal model contract selects short source refs exposed by the Search
  child. Host transport resolves only those exact invocation-local refs to
  received URLs; facts, confidence, titles and order stay model-authored. The
  public report retains `sources:{title,url}`, with no ref field or URL guessing.
- Validator rejects unknown fields, duplicate sections, unsupported URLs and
  incoherent no-match results. Every cited URL must have a Search grounding
  receipt exposed to the model. Unknown refs, parent-only metadata and raw-URL
  fallbacks cannot authorize a citation. A no-match report also needs Search execution evidence; an offline
  answer or refusal is unavailable, not proof of absence. Empty results show
  an explanation and Skip, without preparing memory. Failed research can retry.
  Host policy does not rewrite facts or choose their meaning.
- Admission: current first-party owner/chat key, completed account setup,
  fresh Firebase identity plus the canonical onboarding name when Firebase's
  name is absent, verified contact identifiers, bounded owner checks and
  `ONE_PROFILE_RESEARCH_ENABLED` (default off). Background drafts use bounded
  person-key encrypted checkpoints in the existing session store, private
  no-store responses and a session-only chat card; they bypass transcript
  persistence, PKM writes and automatic memory capture. Cached release binds
  current identity and authored research policy; policy changes preserve the
  three-starts/hour research budget rather than resetting it.
- Independence: personal research has its own flag and generic owner/setup
  admission and private-response utilities. It never requires Business
  Intelligence, a company record, or company ownership. Career, education and
  public personal findings can form a complete card; business is optional.
- Wire boundary: `POST /api/one/profile-research` takes no identity body;
  owner identity is selected at ingress. It returns `status`, `pkm_written:false`
  and, when offered, `report` plus bounded Google Search suggestions. The
  platform-aware One API transport supports both web and native callers.
  The compatible synchronous POST retains three requests/hour and a 40-second
  deadline. The authenticated POST/GET jobs path detaches a 200-second execution
  from browser polling, with at most three actual research starts/hour. No
  provider error text is returned.
- Saving: checked/edited statements go through the existing semantic PKM
  preview. Only final confirmation writes ciphertext. Reconciliation includes
  relevant existing personal and business entities. A known business keeps its
  pinned UID, including retargeted scopes; the writer rechecks current origin
  on conflict retries. Stable review scopes use owner-bound commit receipts to
  recover lost responses. New public business facts can be kept through this
  same review; they do not mint directory provenance or assert verified
  ownership. Sharing changes require acknowledgement.
- Licensed use: the operator confirmed the Google agreement permits these
  owner-reviewed research findings to be saved in PKM.
- Live eval before promotion: synthetic installed-ADK and host boundary tests
  only. Before enabling the flag, evaluate owner-consented public profiles,
  common-name/no-match/conflicting evidence, citation attribution, and exact
  web/native review/save flows. No live quality or device proof is claimed.

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
- Validator, normalize only: `locate_source_quote`
  (`hushh_mcp/services/pkm_source_quote.py`) maps each quote onto the owner's exact text.
  An exact substring wins; otherwise both sides fold, per character: NFKC compatibility
  forms ("…" to "...", fullwidth to ASCII), Markdown emphasis, heading and code marks,
  dash and quotation-mark variants, whitespace runs, case (casefold) and apostrophes. The
  whole folded quote is tried first, so the owner's own end punctuation stays in the span,
  then the quote with its edge punctuation (space, `.,;:!?` and `"`) trimmed, leaving at
  least two letters or digits; a folded match may not begin or end inside a word. The returned span
  is always the owner's exact ORIGINAL characters;
  there is no fuzzy repair. A translation, paraphrase, person rewrite or invented clause
  still matches nothing: it fails closed, is dropped alone and counted
  (`unmatched_quote_count`, `segment_quote_unmatched`); the device shows its lines as
  "not yet saved". It no longer discards the whole section.
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
- Authority: the tool writes nothing. An explicit owner-chosen preferred name
  returns `preferred_name_update_ready` only for admitted typed chat. The live
  device commits only that name after successful turn completion through
  `one_chat_preferred_name`; current-owner, vault-session, conversation and turn
  checks run before effects. Cancellation, conflicting results and stale turns
  do not dispatch a write. An already-dispatched write may still commit; a
  replaced session suppresses cache publication and acknowledgement. A newer
  name also replaces the pending onboarding name draft so final setup Save
  cannot restore the older choice. Other style values require Settings Save. The
  prompt section is rendered from server templates, owner text is a quoted
  literal, and no tool gate reads the style state
  (`tests/test_one_owner_style.py` asserts unchanged authorization decisions).
- Live eval before promotion: none yet. Mocked contract tests only; whether One
  follows each template turn after turn is unmeasured.

### Declared: explicit onboarding preferred-name answer

- Owning agent and manifest: `agent_one`, `agents/one/agent.yaml`. While the
  device's Something else name question is active, One assesses the reply using
  `propose_style_settings` with `onboarding_action` and `onboarding_request_id`.
  No host name-shaped, keyword or regex classifier decides meaning.
- Output: `onboarding_name_assessed`, the matching request id, and a decision
  (`name`, `skip`, `clarify`, `other`). Only `name` carries `preferred_name`.
  This is distinct from the ordinary `offer_ready` Settings proposal.
- Validators: authenticated typed-chat vault admission, current screen nonce,
  closed action choices, no other style fields, and the existing 64-character
  name bound. The nonce grants no authority. Missing or invalid output never
  triggers a fallback name extraction.
- Authority: the person's answer to the explicit name-entry question permits
  the device's existing onboarding writer to merge only that name into encrypted
  `identity.communication_preferences`. It commits after successful turn completion,
  with current-owner, vault-session, question and turn checks before storage.
  Skip, ambiguity, unrelated replies, cancellation and stale results write nothing.
  Ordinary chat uses the separate preferred-name device contract above; other
  writing preferences still require Settings confirmation.
- Evidence: backend tool tests in `tests/test_one_owner_style.py` and frontend
  onboarding, stream and browser regression tests. Live semantic behavior remains
  unmeasured until evaluated with the deployed model; mocked decisions prove
  validation and persistence, not the model's interpretation accuracy.

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
  `agent_email_read_analyzer` extracts action items, mail-derived meetings,
  payments due (bills, invoices or failed payments addressed to the owner) and
  security alerts. A brief ("anything important?", "what are my blockers?",
  "anything sensitive?") asks for every category over recent mail outside
  Promotions and Social; the planner writes that query from its instruction.
  Asking who mailed them today is a listing, not a brief: the planner selects
  `search_inbox` with that day's `after:` term and no category exclusion, so
  newsletters and social senders are included.
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
  owner's Calendar. In typed chat, a successful analysis also returns
  `MailBrief` (`email_mail_brief.py`): code counts the model's findings per
  category and carries display names, address-masked subjects and times, never
  bodies, addresses or provider IDs. It renders as cards on the owner's screen,
  and durable chat history redacts it with the rest of the read result.
- Live eval before production promotion: run a consented UAT session on an owner
  mailbox with positive and negative personal-information requests, an action
  item with a later completion, an invitation with a later cancellation or
  reschedule, a bill due and a failed payment, a security notice, and promotional
  mail that must not appear in a brief. Verify the bounded search scope, source
  and Open bindings, correct timezone, partial-category failure, and the
  continuous One Voice conversation across in-app navigation. Synthetic contract
  tests prove the safety boundary; they do not establish classification accuracy
  on a live mailbox.

### Declared: live Gmail receipt read-through

- Owning agent: the Email specialist child `agent_email_receipt_extractor`.
  The backend owns Gmail transport and authorization; this existing manifest-owned
  child alone decides `is_receipt`, `event_type`, and which supplied evidence
  candidates support the normalized receipt fields.
- Manifest path: `consent-protocol/hushh_mcp/agents/email/agent.yaml`.
- Structured output: `EMAIL_LIVE_RECEIPT_EXTRACTOR_SCHEMA` in
  `consent-protocol/hushh_mcp/agents/email/runtime.py`. It returns receipt and
  event decisions, confidence, nullable merchant/order/amount/currency fields,
  and an evidence ID for every selected semantic value. The public read-through
  DTO adds only provider facts and normalized transport fields such as the
  account-bound `source_id`, Gmail message/thread IDs, sender, date, subject,
  preview, and reviewed canonical merchant domain.
- Validator: `gmail_live_receipts_service.py` supplies bounded, untrusted email
  evidence and a reviewed sender-domain merchant candidate. Deterministic code
  may validate exact evidence IDs, normalize representation, and reject an
  unsupported or conflicting value; it never substitutes its own merchant,
  order, amount, currency, receipt decision, or event. Gmail `internalDate`, a
  valid `Date` header, provider IDs, and sender-domain syntax remain transport
  facts. Missing evidence stays null, and a model timeout or malformed output is
  a typed unavailable/error result rather than a successful empty mailbox.
- Authority and storage: scan and detail require the same Firebase owner and
  current `vault.owner` capability, reuse the encrypted server-side Gmail
  `gmail.readonly` grant, recheck the grant/account before publication, and emit
  private no-store responses. The path is stateless apart from legitimate OAuth
  token refresh; it never writes `kai_gmail_receipts`, receipt-memory artifacts,
  or another receipt store.
- Live eval before production promotion: use an authenticated, legitimately
  unlocked UAT owner mailbox and prove a non-fixture scan response, a visible
  Recent receipts row, and exact selected-source detail. Include positive and
  negative receipt candidates, a technical Myntra sender, missing amount,
  unknown merchant, distinct orders, fulfillment updates, and a refund. Record
  only sanitized counts/status and never mailbox content or identifiers. Mocked
  extraction and responsive fixtures prove contracts only; until this live gate
  passes, browser/iOS/Android receipt readers remain demoted rollback code rather
  than a parallel production authority.

### Declared: Email receipt requests handed back to One's receipt functions

- Owning agent: `agent_email_read_planner`. From the owner's current request alone
  it decides that the question is about their own receipts, invoices, bills,
  purchases or spending and plans `use_receipt_functions`; a request to find or
  read emails that mention a receipt stays `search_inbox` or `read_message`. No
  phrase table, regular expression or keyword list in the route, on the device or
  in host code selects the operation.
- Manifest path: `consent-protocol/hushh_mcp/agents/email/agent.yaml`.
- Structured output: `MailReadPlan.operation: "use_receipt_functions"` with no
  receipt fields (`email_delegated_read.py`, `extra="forbid"`). The typed-chat
  read returns `structured.status = "receipt_functions_required"` with the fixed
  `RECEIPT_FUNCTIONS_TEXT`, no sources, no directive and no navigation. Voice keeps
  its `invalid_argument` refusal.
- Validator: the read builds no Gmail reader for this plan, so it cannot reach the
  mailbox; a plan carrying categories, an ordinal or a target is refused as
  `invalid_argument`. The skip is recorded (`one_voice.mail.latency stage=receipts
  status=redirected`). One's `_specialist_turn` adds a fixed next step to answer
  with its on-device receipt functions. `after_external_read_tool` never clears
  the typed-chat read barrier: it records a separate marker for this invocation,
  and the barrier then also admits only One's device receipt tools and
  `get_current_time`, because another read in the same turn may have set the
  barrier with provider text. Two schema violations are caught and recorded,
  never decided for One: a read call missing a required argument reads nothing
  and is refused with `missing_argument` without arming the barrier or recording
  a Drive outcome (`one.read_call_refused`), so One can retry once in the same turn
  (a second empty call closes the turn's tools like a read, so it can't loop);
  and a receipt call whose arguments fail the closed schema is removed from the
  model response in `receipt_after_model` before the bridge can defer it to the
  device (`one.receipt_call outcome=invalid_dropped`), failing the turn closed
  when the response holds nothing else. Receipt results return in a new turn where every
  tool is refused, checked against the closed result schema.
  Host code never runs an Email proposal, including the retired Open Receipts
  action.
- Receipt functions: the owner's device computes lists and per-currency totals
  over its encrypted snapshot (`hushh-webapp/lib/mail/receipt-analysis.ts`). The
  hub validates the closed request and result (`receipt_client_tools.py`,
  `receipt_result_contract.py`), including the closed unavailable codes
  `gmail_not_connected`, `receipts_not_synced` and `receipt_snapshot_unavailable`.
  The retired saved-receipt-memory read (`receipt_memory_read.py`) has no producer
  in typed chat; the hub drops `receiptMemory` at ingress.
- Live eval before production promotion: on a consented UAT owner session, "what
  did I spend last month", "show my invoices" and "do I have overdue bills" must
  plan `use_receipt_functions` when they reach the Email agent, while "find the
  email with my Amazon receipt" stays `search_inbox`. One's own first tool for
  spending questions is measured by the `receipts` family in
  `consent-protocol/scripts/eval_cases/one_first_tool.v1.json`.


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

### Declared: One Voice spelled name words

- Owning agent: the One Voice Live head. It decides that the person spelled a
  word of a circle's name letter by letter ("h u s s h", "double s", "V zero
  four"), joins exactly those letters and digits, keeps the rest of the name
  as given, and declares the word in `spelled_words`. When the person corrects
  the name on the card, it changes only what they corrected and declares each
  changed word in `changed_words`. It decides when the person changed or
  dropped an earlier spelled word, or is now naming a different circle, and
  declares it in `release_spelled_words`; when a word is unclear, or the person
  says the name is wrong without giving the fix, it asks them to spell just
  that word. Host code never reads letters out of a transcript, never decides
  whether two names are the same circle or whether the person asked for a
  change, and never changes the name.
- Manifest path: the voice head instruction in
  `consent-protocol/hushh_mcp/agents/one/agent.yaml`
  (`capabilities.voice_head.instruction`, "Names are exact"), narration rule 4
  in `consent-protocol/hushh_mcp/one_voice/instruction.py` (a correction is
  proposed again in the same turn, changing only what was corrected and
  declaring each changed word), and the `create_circle` declaration in
  `consent-protocol/hushh_mcp/one_voice/tools/circles.py`.
- Structured output: `CreateCircleInput.spelled_words` and
  `CreateCircleInput.release_spelled_words`, each at most 4 words of 1 to 40
  letters, digits or combining marks, and `CreateCircleInput.changed_words`, at
  most 8 `{old, new}` pairs, all beside the model's own `name`. As
  storage-safe structure normalization of the declared field only, letters
  sent one by one ("H-U-S-S-H") are joined and apostrophes, hyphens and periods
  inside a word are dropped; any other space makes the word invalid.
- Validator: `consent-protocol/hushh_mcp/one_voice/tools/spelling.py` checks
  that every spelled word (those declared now and those retained from earlier
  in the conversation in `EntityContext.spelled_name_words`, kept for 3 minutes
  after their last use and cleared once a circle is created or already exists)
  is a whole word of the name, ignoring case only. The declared word and the
  name are normalized the same way (combining marks are part of a word;
  apostrophes, hyphens and periods inside a word are ignored; letters spelled
  one by one are joined). There is no fuzzy or accent-folded matching. A name
  without one is refused (`spelled_word_missing`, `needs=repeat_name`) with one
  spoken question per word, and the open `create_circle` card is retired in the
  same step so a later yes cannot approve the rejected name; if the card cannot
  be retired the call fails closed (`storage_unavailable`). The same check runs
  again when a card is confirmed, against the card's own words and the words
  retained at that moment. The guard logs that it fired
  (`one_voice.spelling.refused`, a count only). The card and the spoken
  confirmation spell each word out ("..., with HUSSH spelled H-U-S-S-H") as the
  person's check. The name the model returned is never rewritten.
- Name under review: the last `create_circle` name that passed is kept in
  `EntityContext.circle_name_baseline` for 3 minutes, across a cancel, and
  cleared once a circle is created or already exists. A proposal that shares
  at least one word with it, or whose `changed_words` names one of its words
  as an `old`, is a correction of it. In each stretch where the names differ,
  every word a correction adds must be declared as a `new` or spelled in the
  same call, and every word it removes must be declared as an `old`, released
  in `release_spelled_words`, or replaced by one of those spelled words. Each
  declaration and each spelled word accounts for one word once: a spelled word
  declared as a change's `new` replaces only that change's `old`, a word
  declared removed or released with a spelled word in its stretch is one
  respelling, and a pair naming the same words in the same order declares
  nothing. A declared side is read against the name it describes (its words
  as written when each is a word of that name, else letters joined into one
  word). A moved word is
  removed in one place and added in another, so a move is declared like any
  other change. Otherwise the call is refused (`name_changed`,
  `needs=repeat_name`) with one spoken question naming the undeclared change
  ("This would also change GARAGE to GARAZ. Is that what you want?"), and the
  open card is retired the same way. Which words changed is the exact word
  comparison above; whether the person asked for the change is only the
  model's declaration. A proposal that shares no word and declares no change
  to one is a different circle and is not compared. Logged as
  `one_voice.name_lineage.refused slots=N order=kept|moved` (counts only).
- One declaration changes a spelled word: a `changed_words` `old` the new name
  no longer has, or a word spelled in this call in an old word's place,
  releases that spelled word. Only a call that passes the comparison releases
  anything, so a refused call leaves every spelled word kept. A spelled word
  that merely goes missing is still refused.
- Invalid correction: a `create_circle` call whose arguments fail validation
  while a card is open (`ToolSpec.on_invalid_correction`) retires that card.
  When a spelling argument is what failed it asks for that word
  (`invalid_spelling`, `needs=repeat_name`); otherwise the refusal names the
  argument that failed. It fails closed (`storage_unavailable`) if the card
  cannot be retired. Logged as `one_voice.pending.retired
  phase=arguments|prepare`.
- Typed name: a name the person types on the card (Edit name,
  `ToolContext.typed_name`, set only by the relay's `name_edit.submit` path)
  is theirs as written. It releases every spelled word, skips both checks and
  the spelled read-back, and becomes the name under review
  (`one_voice.circle_name.typed`).
- Live eval before production promotion: the circle tool-selection eval's
  `spelled_name` family, which scores the `name`, `spelled_words` and
  `release_spelled_words` arguments as well as the tool choice, sampled
  several times per case on the UAT Live model against a main baseline. Only a
  proposal the server accepted that is still open at the end of the turn
  scores (a new card, or the executor's reuse of the open card; never a held
  call), and more than one distinct open proposal is a miss
  (`extra_proposals`). Its spelled examples share no words with the production
  prompt (a held-out check rejects any 6-token overlap). It includes real
  "Hush" and "Hash" names that must not become "Hussh", near-brand spellings
  (HUSS, HUSSHH), an intentional change back to one S, a different circle after
  a cancel, a later correction that must keep the spelled word without listing
  it again (`spelled_name-013`), a spelled first word that replaces only that
  word (`spelled_name-014`), and a name called wrong with no fix
  (`clarify-013`).

### Declared: One Voice proposals held while a card waits

- Owning agent: the One Voice Live head proposes; only the person answers a
  card. UAT 2026-10-06: 14.5 s after a card was read back, with no input
  transcript, Live proposed again with different arguments and replaced the
  card the person was about to answer.
- Rule (`consent-protocol/hushh_mcp/one_voice/session.py`, `_held_card`): a
  confirm-tier proposal, or a `confirm_pending_action` /
  `cancel_pending_action` call, is held unrun when Live makes it in a
  continuation with no input of its own (bound to an earlier input, with none
  newer and none in progress) that Live opened owing nothing (no tool result
  or app event waiting for its reply), or right after a held answer, while a
  card already presented waits. Structural, never lexical: the call's
  arguments are never read. A tool result, an app event, or anything the
  person says lets the next call run as the model asked. Once Live has
  answered it, an app event the person did not cause (`ui_settled` for Live's
  own navigation, `session_ending_soon`) leaves the hold in place.
- Recovery (`_shown_recoveries`): the one exempt card answer is the person's
  own yes. When their confirm was refused as `card_not_shown` and the client
  then reports that card shown, the relay records the card with the input
  whose yes was refused, before it tells Live (`[ONE_EVENT] pending_shown`).
  While that input is still the person's latest, Live's first
  `confirm_pending_action` whose waiting card (the card the hold found, never
  the call's arguments) carries the record runs, however Live's reply and the
  event interleave. That use spends the record and the person's next input
  drops it. It is logged as `one_voice.tool.recovered after=…`, without the
  card.
- What the model gets: `confirmation_waiting` with `reason_code=awaiting_answer`,
  the waiting card's id and no spoken facts (from the third hold in a row, a
  note to wait for the person's answer). The card is not cancelled, replaced
  or sent again, and the client gets a not-ok result. If the waiting cards
  cannot be read, a card answer made this way is refused
  (`storage_unavailable`, nothing changed, no spoken facts) instead of run.
  That refusal counts as a held answer, so Live retrying it at once, in the
  same provider turn or the next continuation, is checked again even when
  storage is back.
- Recorded: every hold is logged as `one_voice.tool.held tool=… after=…` and
  counted as `held` in the session's perf line, so a skipped call is never
  read as one the executor answered.
- Not covered: Live repeating the question in speech without a tool call; a
  continuation that opens with Live's own read tool call (its result lets the
  next call run); an app event Live answers with silence, after which the
  next continuation still counts as answering it; and a confirm Live makes in
  the same input that proposed the card, refused as `card_not_shown`, which
  is recorded like a person's yes (structure cannot tell it from a yes given
  with the request, such as "call it Home instead, yes").


### Declared: default-on Personal World Model research

- Owning agent: One's `one_personal_world_model` manifest specialist, entered by
  the authenticated `ensure` call after setup is resolved and the vault is
  unlocked. Research is on by default after setup discloses it; `ensure` creates
  a missing preference row as enabled and never flips an existing `enabled=false`
  opt-out. It chooses source queries, identity pivots, evidence interpretation,
  fact support, coverage gaps and plain-English summaries.
- Owner decisions: `ensure` and `POST /jobs` accept bounded `owner_decisions`
  (`confirmed`/`rejected`, at most 269 statements of 1 to 600 characters each),
  stored in the sealed job state under `inputs` and passed to the specialist as
  data. The authored manifest instruction tells the model not to propose those
  claims or equivalents again and never to infer an opposite. Explicit Update can
  separately approve a frozen `research_context` snapshot of saved confirmed
  statements as `owner_confirmed_research_leads` for planning and query terms.
  The full decisions object and rejected/removed statements never enter search.
  Leads cannot establish independent evidence or identity and are not carried
  into fresh automatic generations. The model decides
  equivalence; host code only validates the bounds, and the client hides only
  drafts whose claim key exactly matches a decided key.
- Host contract: verified owner/setup/vault authority; exact contact matching for
  invitation claims; bounded durable attempts, timeouts, response schemas and
  receipt resolution. These checks cannot promote an uncertain candidate or
  manufacture a numerical confidence probability. Python rejects inconsistent
  identity/report enums; it does not recompute a successful semantic answer.
- Persistence: an owner's Yes, Edit, Remove or No is written in the browser to
  the encrypted Soul.md domain `one_memory` through the existing compare-and-set
  writer. Yes saves the exact statement, Edit only the owner's wording, Remove
  deletes the bullet, and No writes no bullet and never an opposite. Private
  `_pwm_claims` metadata keeps decisions and is never sent to a model as memory.
  Independently supplied source facts use the existing exact review mutation;
  their source references resolve only from received tool receipts. Draft
  generation IDs and CAS fences reject stale dismissal/completion. The page
  shows saved owner decisions; it does not synthesize new claims.
- Failure: missing provider, exhausted budget, invalid output or authority loss
  yields unavailable/disabled; never inferred no-match. The job records terminal
  state and attempt charges without logging identity or query contents.
- Evidence: checkpoint/revocation/completion tests, default-preference and
  `owner_decisions` bound tests, and invitation authority tests exercise
  production services. Live precision, preference attribution and
  latency require consented live evaluation through managed Vertex.
- Native Google responses stay view-only: grounded answer text, grounding URLs and
  titles, and search-suggestion HTML are never persisted to memory, and
  `/source-reviews/complete` refuses a display-only draft with 409. Search
  suggestions are still displayed with the grounded findings. Independently
  supplied permitted URL Context sources produce a separate `ProfileReport`
  review draft. Successful requested-URL receipts, purpose bounds and exact
  selection protect that save path. The same manifest owns both modes; the host
  never turns grounded links into crawl inputs.
- Structured intelligence contracts: `QueryPlan`, `IdentityAssessment`, and
  `WorldModelReport` in `one_adk/world_model_contracts.py`. Evidence existence,
  candidate membership, conflict conditions and topic receipt checks validate
  model output; they do not choose queries or generate replacement interpretations.
- Scope and exact prompt: [Personal World Model KT](../../../docs/reference/one/personal-world-model.md).
- Azure UAT: GPT-5 mini owns planning, candidate assessment, attribution and report
  meaning using that same manifest. Adapter instructions select the execution
  stage and conservative citation-only identity boundary; native JSON schema and
  host validation reject malformed or unreceived evidence, not semantic
  duplicates. Provisional extraction, compilation and final fact review use
  bounded instruction blocks authored in the same PWM manifest, with no
  retrieval, identity-verification or save authority; it does not inherit the
  whole research task's unrelated duties. The model chooses which distinct
  findings remain. Fact review returns immutable fact IDs and a summary; the host
  resolves that subset without rewriting any statement, topic, confidence or
  citation, then revalidates the original evidence contract. Its charged result
  is bound to the checkpointed intermediate report, so resume never silently
  reruns compilation. Selecting zero claims preserves the assessed identity;
  an empty matched/uncertain report is valid, while no-match still forbids claims. Stage
  instruction and reasoning changes enter the existing policy fingerprint.
  Candidate/source ID namespaces and observed-attempt gates enforce evidence
  provenance, not meaning.
  The policy fingerprint includes active stage instructions and transport bounds,
  invalidating old drafts while preserving paid-attempt accounting. The existing
  no-traffic candidate probe evaluates six synthetic attribution cases and the
  production output schemas through the real primary gateway. Live owner precision and nonprofessional/social
  coverage remain separate quality questions; no claim count proves them.

### UAT Drive query-match delivery policy v2

New UAT requester-origin automatic document requests seal policy version 2.
The existing Documents planner remains the sole author of the complete typed
search expression. The host compiles all supported predicates to Drive query
syntax without substituting a successful model field or dropping a condition.
This interaction delivers provider-search matches, so the document-content
assessor stage is intentionally not applicable; it is recorded as such in
`drive_query_matches_v1` provenance and closed operational telemetry. This is
an explicit delivery-policy change, not a claimed successful or failed content
assessment. No content-verification score, citation or fingerprint is invented.
Provider-inexpressible content-period or account-relationship requests require
clarification. Existing v1/package assessments and their byte-exact manifest
policy hash remain unchanged. Permission, consent, date scope, payment and
external-effect idempotency remain independently authoritative.


### Declared: predefined financial packet retrieval and local organization

Fixed financial packets explicitly retire model query planning in favor of the
versioned product preset `financial-records-v1`. This is a changed owning contract,
not a silent model failure fallback: `query_source` records `predefined`, version,
and `planner_executed=false`; the exact template and compiled query are validated
at search boundaries. The descriptor AST does not pretend to be model output.
Custom user-authored search and the generic model grammar remain unchanged.

Drive query membership and the existing metadata date precedence own retrieval.
All unique originals are saved and visible before asynchronous organization.
The unchanged local `drive_groups` classifier owns advisory grouping from its
existing bounded-head/metadata/embedding evidence; host code only maps its closed
financial/insurance groups, abstentions and other groups to presentation buckets.
No semantic keyword classifier, cloud assessor, second router or new index is
introduced. Compatible exact-source owner corrections retain precedence. Labels
never become content verification, sharing permission or a purchase decision.

See [the owning packet contract](./drive-continuous-packets.md)
for enrollment, migration, recovery and privacy boundaries.

### Declared: in-app activity digest

Founder decision, 2026-10-29. One's in-app activity log reaches memory only
through the existing Soul.md memory pipeline. No new route, model profile or
agent is added.

- Owning agents: the existing `agent_memory_segmentation`, `agent_memory_intent`,
  `agent_memory_merge` and `agent_pkm_structure` decide which activity is a
  durable fact, where it belongs and whether it creates, extends or corrects a
  memory, or is a no-op. Manifests under `consent-protocol/hushh_mcp/agents/`.
- Structured output: the existing `POST /api/pkm/memory/proposals` preview cards
  under `memoryProfile: "soul_markdown_v1"` and `currentDomains: ["one_memory"]`,
  prepared through `prepareNaturalLanguagePkm` with the client-log label
  `app_activity_digest`. The proposal request carries no source, so the memory
  agents receive the digest as first-person text, and each cycle offers the
  current memory.md bullets as reconciliation candidates, as ambient chat
  capture does. Only the write record `app_activity_product_default_auto_save`
  identifies activity. Usable facts are staged with `stageMarkdownMemoryFacts`.
- Host policy (`hushh-webapp/lib/pkm/live-activity/`) enforces form and
  authority only. It renders allowlisted events into dated first-person lines
  (`liveActivityStatements`), enforces the field allowlist in
  `live-activity-types.ts` and coalesces exact repeats. It never decides that an
  activity is durable, never adds or rewrites a fact, and never writes when
  preparation is incomplete, degraded or a fallback.
- Authority: activity never removes a memory. A delete decision, or a
  correction whose replacement would save as nothing or as another existing
  bullet, fails the whole cycle closed, because a delete can pair with a create
  to express a move and half of it is never applied. It is reported as
  `failed`. Other corrections and extensions stay within this writer's declared
  authority.
- Declared input filters, applied before the model and recorded here:
  - Within one cycle's events, opposing pairs (connect/disconnect per service,
    save/remove per place, link created/revoked) collapse to the latest
    observed state. A day can arrive in several cycles, and the counts in a
    line cover only that cycle.
  - Visits to the One home section are not a usage statement.
  - Memory saves, consent decisions, profile updates and successful connector
    syncs are never sent, because they are already saved by their own owners or
    carry no durable meaning. They still show in Today and in the per-turn
    packet. A failed sync is not recorded at all: it is not an owner action and
    offers no fix there.
  - Place labels are third-party or free text (a Google venue's public name,
    from a check-in or a place saved from one, or the owner's own place name), so the digest and the per-turn packet render
    them as quoted names. A label that repeats the place's own street address
    is dropped, best effort.
  - An event that can still absorb repeats (seen within the 10-minute coalesce
    window) waits for a later cycle, so a repeat never merges into an event
    already sent.
- Each cycle covers the not-yet-consolidated events of one local day, so no
  statement is truncated. Each run reads memory.md from the server first and
  does not run while a local memory save is still pending (`saving` is
  cancelled, `retryable` is `failed`), so a device whose cached copy predates a
  Reset on another device never writes that old document back. The outcome is recorded as enums through the dedicated
  `live_activity_consolidation_completed` event:
  - `saved`;
  - `nothing_durable`: the model kept nothing new, or only facts memory.md
    already holds;
  - `host_skipped`: only kinds the digest never describes, settled without
    asking the model, so a host decision is never counted as a model answer;
  - `failed`: a counted failure (degraded output, a refused removal, a rejected
    write, a model timeout), or a run that could not read memory.md or found a
    local memory save stuck, which keeps its attempt;
  - `memory_full`: memory.md is near its ceilings or the staged facts would
    overflow it. The events are kept.

  `busy`, `skipped` and `cancelled` runs (stale, aborted or offline) reached no
  decision and are not reported.
- Scheduling: a failed consolidation writes nothing and stays a quiet pending
  state. Runs never start as the app hides, and a run cut off by hiding is
  cancelled. Every run waits at least five minutes after the last. A `failed`
  or `memory_full` run waits for new activity or the next unlock rather than a
  timer; a cancelled run, or one that left a later day queued, retries after the
  gap. After two counted failures a day is settled without a write, so it never
  retries forever.
- Live eval before promotion: mocked contract tests for the host policy only.
  Durable-fact quality on real owner activity is unmeasured.
