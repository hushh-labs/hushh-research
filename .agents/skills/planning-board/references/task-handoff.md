# Implementation task handoffs

Use this when creating or rewriting an issue that a person or coding agent must
implement. Keep one canonical brief: warm and plain for human readers, concrete
and exact for coding agents.

## Ground the handoff

1. Inspect the target branch, current contracts, related issues and live project
   fields. Verify claims before calling something missing or already delivered.
2. Separate current implementation, approved direction, unresolved findings and
   deployed acceptance. Link the sources that establish each material claim.
3. Carry forward the user's decisions: owner/lead, branch/environment, authority,
   consent, supported runtimes, dependencies, acceptance and deviation protocol.
4. Resolve discoverable facts yourself. Ask only for a remaining product/authority
   decision; never invent deadlines, SLOs or pre-filled effort estimates.
5. Ground delivery in the target repository's branch, runtime and provisioning
   contracts. Translate examples into capabilities; a product analogy does not
   itself require new infrastructure or copying another product's limits.

## Phased planning and alignment

Every implementation plan starts with **Phase 0: planning and alignment**; number
later phases consistently for both audiences and scale them to the work. Ordinary
questions and board summaries need no phase ritual.
The owner inspects current state, checks reuse and boundaries, and aligns with
the lead on open decisions before implementation. Ask the owner to submit Phase 0
effort estimates only on substantial multi-phase work when needed; omit estimates
on small, self-contained plans unless asked. Never invent dates or treat an AI
draft as owner review. Carry forward explicit approval, pause only affected work
when a contradiction appears, and name deliverable, exit criteria and reviewer
for each phase.

## Two audiences, one source

Use two top-level sections. Never put em dashes, en dashes or
robotic filler in either section.

### For humans

Write `For humans` like a calm, thoughtful teammate speaking to another person,
never like an engineering log or spec dump:

- Open with **Owner**, **Lead**, **Environment**, in that order, then honest
  human-review status; link verified people. Let the Environment label state the
  target without prepending boilerplate promotion warnings.
- Connect what is happening today -> problem felt by people or the team ->
  chosen direction -> practical tradeoffs -> clear outcome.
- Keep technical plumbing out of `For humans`: do **not** put file paths,
  module/class/function/service names, env vars, CLI commands, HTTP status
  codes, protocol/crypto acronyms, CPU/RAM sizing, database millisecond timings,
  or line-count caps in human prose unless a specific user/pricing/business
  number directly changes a human decision. Move all implementation mechanics,
  paths, limits and inventories into `For coding agents`.
- Explain product roles through purpose and what a person actually sees or does.
- Give numbered phase checkboxes starting with Phase 0 alignment, then plain
  deliverables and observable exits for each phase.
- Keep requested references and canonical links visible here, stating briefly in
  human terms why each link matters.
- Include one concrete journey (ask -> review -> act -> failure/cancel) when it
  clarifies what a person experiences; state the owner's next action plainly.

The named owner must read, edit, validate and approve the decisions they own;
record the real reviewer and evidence when completed. Never sign off on someone's
behalf or infer approval from assignment.

### For coding agents

- **Verified starting point:** owning modules/contracts, inspected revision,
  known gaps, compatibility paths and measured baselines.
- **Implementation mechanics:** canonical writer/store, small-module layout,
  interfaces to extend, data flow, identity/key custody and auth checks.
- **State and failure rules:** revision conflicts, idempotent retries, unknown
  outcomes, cancellation/revocation, invalidation and recovery.
- **Direction boundaries by phase:** exact outcome, included/excluded scope,
  authoritative modules, permitted edits, preserved contracts and cutover/rollback
  safety. Report material contradictions before changing agreed direction.
- **Verification:** positive and negative cases, client/runtime parity, exact
  test commands, measurement rules and distinguishing local tests from live proof.
- **Coordination and references:** preserved issue links, exit reviewers and
  canonical repo sources. Link existing docs instead of copying them.

## People and reference links

- Verify GitHub identities from live assignees/profiles; never guess a login.
- Link the first explicit attribution: `**Owner:** [Full Name](https://github.com/login)`.
  Do the same for lead and named reviewers; later prose can use names.
- Task links use `#<number> <title>`. Label private/local-only references clearly;
  never expose secrets or private personal data.

## Decision and evidence quality

Every component, phase and constraint must solve a stated problem; an inventory
alone is not a design. Keep tooling, skill names and chat meta-history out of
issue prose. Separate approved rules from starting defaults, measured metrics and
still-open lead decisions. Source checks, isolated tests, deployed behavior and
user acceptance are distinct claims.

Calibration examples (reuse the human clarity and structure, not their domain rules):

- [#9370 Dev: personal wiki memory, consent-safe PKM projections, and ADK recall](https://github.com/hushh-labs/hushh-research/issues/9370)
- [#184 Rebuild Metrics as a small, accurate internal dashboard on Next.js](https://github.com/hushh-labs/hussh-matrix-dashboard/issues/184)

## Quiet GitHub updates and decision preservation

1. Verify `gh api user` before mutating GitHub; use the authenticated CLI for CLI requests.
2. Read the current issue and comments before editing; update the canonical issue
   in place instead of posting repeated comment summaries.
3. Keep the human section plain and the untouched agent section exact when revising
   only one side; preserve assignees, status, dates, labels and parent links unless
   explicitly asked to change them.
4. Before handoff, read `For humans` alone from top to bottom: can a teammate
   understand the whole plan, tradeoffs and next action without translating code
   jargon or wading through inventories? If not, move technical detail down to
   `For coding agents` and rewrite in plain English.

## Compact starting shape

```markdown
## For humans

**Owner:** [Full Name](https://github.com/verified-owner)  
**Lead:** [Full Name](https://github.com/verified-lead)  
**Environment:** <verified target>  
**Human review:** Pending. The owner should review, validate and approve the decisions they own here.

Plain story: what is broken today, what we are changing, practical tradeoffs, a
short user walkthrough, references and the owner's next action.

- [ ] **Phase 0: Owner review and alignment.** Review current behavior and confirm open decisions (plus effort estimates if multi-phase work needs them).
- [ ] **Phase 1 onward:** Clear deliverables and what done looks like in plain English.

## For coding agents

Verified starting point, modular seams, technical limits and per-phase obligations.
State/failure rules, tests, docs consolidation, live verification and rollback.
```

This is a navigation shape, not a permission to drop real product boundaries.
