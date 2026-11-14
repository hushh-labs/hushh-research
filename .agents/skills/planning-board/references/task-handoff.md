# Implementation task handoffs

Use this when creating or rewriting an issue that a person or coding agent must
implement. Keep one canonical brief: readable for the owner, specific enough that
the implementer does not have to reconstruct decisions from chat.

## Ground the handoff

1. Inspect the target branch, current contracts, related issues and live project
   fields. Verify claims before calling something missing or already delivered.
2. Separate current implementation, approved direction, unresolved findings and
   deployed acceptance. Link the sources that establish each material claim.
3. Carry forward the user's decisions: owner/lead, branch/environment, authority,
   consent, supported runtimes, dependencies, acceptance and deviation protocol.
4. Resolve discoverable facts yourself. Ask only for a remaining product/authority
   decision; do not substitute an invented deadline, SLO, scope or release grant.
5. Ground delivery in the target repository's branch, runtime and provisioning
   contracts. Translate examples into capabilities; a product analogy does not itself require new infrastructure.
   Reference projects supply patterns, not another product's environment or limits.

## Phased planning and alignment

Every implementation plan starts with **Phase 0 — planning and alignment report**;
number later phases consistently for both audiences and scale them to the work. Ordinary questions and board summaries need no phase ritual.
The owner inspects current evidence, reports the problem/outcome, reuse, boundaries,
dependencies, proof and unresolved decisions to the lead before implementation.
Include per-phase effort ranges, assumptions, uncertainty and access/review needs;
separate effort from elapsed waiting and operating cost where relevant. The lead
reviews estimates and tradeoffs; never invent dates or treat a draft as this report.
Carry forward explicit approval; pause only work affected by an unresolved decision.
Each phase names deliverable, dependencies, exit evidence and accepting reviewer.
Revise estimates with reasons when findings change scope or commitments.

## Two audiences, one source

Use two top-level sections. Human readers own the decisions; their section is a
self-contained decision brief, not a teaser that delegates understanding to agents.
Concision removes repetition, not reasons, directions, references or safety boundaries.

### For humans

- State the outcome in plain language, with linked owner/lead profiles and branch/environment.
- Explain the problem found, the chosen direction and why it is preferable.
- Connect problem → direction → reason/tradeoff → observable outcome; explain
  technical terms at first use through their purpose and user effect.
- State the important decisions and tradeoffs in human terms, including what stays
  authoritative, privacy/consent boundaries and the effect on the person's experience.
- Explain roles through purpose and user effect. Technical detail must change a human decision or tradeoff.
  Keep flags, paths, runtime matrices and inventories in agent guidance or canonical evidence.
- Give numbered phase checkboxes starting with Phase 0 and its alignment report,
  then a deliverable and observable exit for each implementation phase.
- Show requested references and canonical sources here too, with what the reader
  should learn or reuse and the limits of the analogy. Do not hide them below.
- State the next action, who reviews decisions, material blockers and completion
  criteria. A human should understand the task without reading the agent section.
- Include one concrete journey when it helps explain what a person will observe;
  name truthful pending, failed or unavailable outcomes as well as success.
- Explain phase dependencies, review points and independent work that may continue.

The named owner is accountable for reviewing, editing and validating the human
brief: explain the problem, alternatives, tradeoffs and phase exits, check material
claims against evidence, and approve the decisions they own. Assisted drafting
does not establish understanding or approval. Always include a review reminder
and truthful status; identify the real reviewer and evidence when review completes.
Never sign off on someone's behalf or infer approval from assignment or a polished
draft. Keep pending review visible; owner, author and lead are distinct roles.

### For coding agents

- **Verified starting point:** owning modules/contracts, relevant source revision,
  known gaps and required compatibility. An external reference is not repo proof.
- **Implementation mechanics:** canonical writer/store, interfaces to extend,
  input-to-persistence-to-read flow, identity/key ownership and authorization.
- **State and failure rules:** revision/conflict behavior, idempotent retries,
  unknown outcomes, cancellation/revocation, derived-state invalidation and recovery.
- **Decisions by phase:** dependency ordering, per-phase implementation obligations,
  outputs, migration/cutover/rollback boundaries and acceptance evidence.
- **Direction boundaries:** each phase names outcome, included/excluded work,
  authoritative modules, permitted changes, preserved contracts and checks. Reuse
  existing mechanisms; report material contradictions, evidence and the smallest
  correction/impact before changing direction. Pause affected work only; routine
  choices within the accepted contract need no new approval.
- **Verification:** positive and negative cases, runtime/client coverage, measurement
  protocol and applicable existing checks. Distinguish source tests from live proof.
- **Coordination:** preserved issue relationships, who accepts each exit, and what
  evidence an important finding must provide before changing an agreed contract.
- **References:** canonical repo sources and requested primary examples with a short
  explanation of what to reuse and what their evidence does not establish.

Put detailed mechanics in this section or link their existing canonical owner;
do not create another maintained copy of the architecture. Preserve exact agreed
parameters when meaningful; do not invent wire schemas or thresholds for appearance.

## People and reference links

- Verify GitHub identities from live assignees, profiles and the chosen writer;
  never guess a login from a first name or use the author as a substitute for lead.
- Link the first explicit ownership/review attribution to the verified profile:
  `**Owner:** [Full Name](https://github.com/verified-login)`. Do the same for lead
  and any named reviewer/dependency owner. Plain or backticked handles alone are
  insufficient. Later prose can use the person's name without repeating the link.
- Use descriptive repository, issue, PR and source links. Task links use
  `#<number> <title>`; name a cross-repository destination when it is ambiguous.
- Explain what each reference contributes and its limits: prerequisite,
  compatibility contract, prior evidence, separate authority or design example.
  Keep references needed for decisions visible in the human section.
- Bind implementation claims to the inspected source/environment. Use the
  appropriate canonical branch for instructions that follow active development;
  do not cite a moving branch as proof of a previously inspected revision.
- Check access restrictions and label private references. Never copy private
  contents or link local-only evidence as if GitHub readers could access it.
- Profile links communicate responsibility; additional mentions/comments or
  notifications require an actual coordination need within the authorized scope.

## Decision and evidence quality

Make the human brief explain **verified condition → problem → chosen direction
→ reason/tradeoff → observable outcome**. State what to achieve, why it fits, what to preserve and how to judge success.
An inventory alone does not explain a design. Keep writer identity, tooling, skills and chat history out of solution prose unless they affect a real constraint.

Separate approved requirements, protective starting defaults, measured results
and decisions still owned by the lead. Preserve exact agreed limits with units,
scope and verification conditions; do not turn initial values into measured SLOs
or copy thresholds from another product. If limits are undecided, assign the
baseline/estimate and decision owner rather than inventing numbers.
Keep the brief problem-led: every component, phase and constraint must solve a
stated need. Derive operating values from evidence; a long table of arbitrary
defaults does not make a plan precise. Apply later user revisions explicitly.

State who accepts each phase and what evidence unlocks the next. Source tests,
isolated runtime checks, deployed outcomes and final acceptance are distinct.
For an important finding, require evidence, affected contract, smallest proposed
change, verification impact and decision needed; pause only affected work.

Calibration examples, not additional policy or implementation sources:

- [#9370 Dev: personal wiki memory, consent-safe PKM projections, and ADK recall](https://github.com/hushh-labs/hushh-research/issues/9370): linked people, human rationale, Phase 0 design/baseline/estimates report to the lead, phase dependencies and custody/acceptance boundaries.
- [#184 Rebuild Metrics as a small, accurate internal dashboard on Next.js](https://github.com/hushh-labs/hussh-matrix-dashboard/issues/184): a problem-led design, evidence-derived operating limits, phase exits and separate accuracy, performance, cost and cleanup evidence.

Reuse the writing pattern, not the examples' domain rules. Comparing briefs must
not merge their product scope, owners, parameters or release authority.

## Preserve decisions during editing

Before shortening a brief, check each of these against the new version:

- Component roles and canonical versus derived information.
- Approved identity, custody, processing, consent and disclosure boundaries.
- Important current limitations, compatibility paths and planned corrections.
- Concurrency, retries, partial failures, revocation, deletion and recovery.
- Phase order, concrete exit conditions, cohort migration and rollback.
- Required runtimes/clients, gates, measurements and explicit not-run outcomes.
- Material-finding escalation, lead review and independent work that may continue.
- User-requested source references, links, assignment and scheduling decisions.

When improving human prose, compare the untouched agent section exactly, including
numeric contracts. When changing an approved contract, make that change explicit
instead of hiding it inside an editorial rewrite.

Keep the other audience's section stable when the request changes only one. An
edit must not silently broaden scope or change policy. Pending decisions stay
visible with their decision owner; accepted details must not become open choices.

## Identity and quiet GitHub operations

1. Verify the chosen writer's identity before the first mutation. For a CLI request,
   use `gh api user` and the authenticated CLI for all GitHub writes; do not switch
   to MCP/connector credentials. An assignee is not the issue author.
2. Search existing work first. Edit the canonical issue in place. Reuse relevant
   tasks and native relationships without detaching another parent or resetting
   assignees, status, dates or acceptance evidence.
3. Match the requested granularity. A detailed brief does not itself authorize a
   new issue per phase, duplicate board rows, comments or notifications. Put phase
   contracts in the canonical brief and link focused implementation/evidence work.
4. Respect edit-only/no-comment instructions. Update the description/checklist
   rather than publishing repeated summaries. Keep board metadata out of prose
   unless it clarifies an actual execution constraint.
5. Use live field options. Never invent or mislabel an environment. If changing
   the catalog is authorized, preserve existing option IDs and selections.
6. GitHub authors cannot be reassigned. For an identity error, verify the intended
   CLI identity, preserve unique content in one correct canonical issue, and
   reconcile links. Delete old drafts only when deletion is explicitly authorized;
   otherwise retain traceability and avoid another round of duplicate phase issues.

## Read back before handoff

- Compare the proposed edit with the freshly read body; reconcile concurrent work
  instead of overwriting it. Use structured request bodies or properly quoted files.
- Read the human section alone: can the owner explain the problem, chosen path,
  reasons, phase outcomes and next action without translating implementation jargon?
  Check every update; move technical receipts to their evidence owner.
- Verify links, author, assignees, linked owner/lead/reviewers, relationships and project fields. Preserve dates,
  status and unrelated work unless their change was requested.
- Keep sensitive payloads and private evidence outside issues; link only references
  appropriate for the destination's audience and the user's sharing authorization.
- A passing source check, completed implementation and accepted release are
  different claims. Keep blocked, failed and not-run evidence explicit.
- Report the canonical issue link and actual changes once; never claim that writing
  a task implemented its product behavior.

## Compact starting shape

```markdown
## For humans
**Owner:** [Full Name](https://github.com/verified-owner)
**Lead:** [Full Name](https://github.com/verified-lead)
**Human review:** Pending — owner must review, edit, validate and approve owned decisions; record reviewer/evidence.
Branch / environment; problem, outcome and component roles.
Chosen direction, reasons/tradeoffs, concrete journey, visible references, phase dependencies and the owner's next action.
- [ ] Phase 0 — report alignment, gaps, dependencies and evidence-based estimates to the lead; resolve material decisions.
- [ ] Phase 1 — first complete outcome: deliverable, dependencies, evidence, reviewer.
- [ ] Phase 2 onward — remaining outcomes and acceptance, sized to the work.

## For coding agents
Verified starting point and approved decisions; Phase 0 evidence/report-back, then matching numbered phases.
For each: outcome, scope, authoritative modules, permitted changes, contracts, dependencies, mechanics and exit proof.
Failure boundaries, migration/rollback and acceptance cases; references and lead-review/deviation protocol.
```

This is a navigation shape, not a fixed length cap or permission to omit specifics.
