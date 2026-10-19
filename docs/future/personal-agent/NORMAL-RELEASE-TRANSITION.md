# Private agent: normal release transition

**Status:** local proposal, 2026-10-18. No push, application main merge or deployment
is authorized by this document. Source reviewed against `origin/main` at
`135d3c9d2a87` and the infrastructure candidate's main integration `32c9342806`.
The [readiness memo](../../reference/quality/adk-orchestration-docs-audit.md) owns
actual journey acceptance; this plan does not convert source checks into live proof.

## Decision

Use the normal PR validation and release machinery for the private agent. Dev,
UAT and production share one implementation of candidate selection, build,
verification, rollout receipts and failure settlement. Keep explicit environment
policy: dev can qualify an exact green branch revision; UAT and production require
a reviewed green main revision and their existing release authority.

Existing BYOC owners stay on their assigned pod. Eligible legacy Shared users
continue on Shared without a new cloud setup. Unknown placement stays explicit.
Hub deployment never installs an owner-pod image.

## 1. Finish and freeze the source

- Fresh main is integrated locally. Preserve pod authorization, bounded streams,
  reconnect/resync, connector route registration and current Profile behavior.
- Preserve the active ADK worktree. Its frozen `0eedb8a366fb` delta needs authority
  reconciliation before inclusion: extracted AI settings must retain Azure-aware
  pod selection and key readiness; device models must retain Puppy grant and
  revocation; Memory must retain identifier-processing consent and sharing controls;
  World Model writes must retain owner-current and abort checks. Regenerate
  projections from the merged authored owners. A merge commit alone proves no parity.
- Keep unrelated PDF, native dependency and tooling edits outside the release.
  Freeze one dependency-complete revision after these seams are resolved.
- Run affected contract checks while implementing. Run the local core mirror once
  on that final revision, then one hosted PR validation after a later authorized
  push. Re-run a failed job; do not push repeatedly to monitor CI.

## 2. Consolidate the existing release path

Local cleanup removes the two duplicate pod-only scheduled workflows and standardizes
13 display names. Normal Protocol CI retains both core suites. See the
[workflow catalog and timing review](../../reference/operations/ci.md#workflow-catalog-and-naming).
Core gate names, deployment authority and capacity tick titles are unchanged.

All three workflows already share `resolve-deploy-scope.py`, Cloud Build templates,
immutable image handling and revision-provenance helpers. Consolidate measured
remaining duplication in those owners; do not create a second release authority.

| Surface | Proposed change | Preserve |
| --- | --- | --- |
| PR validation | Keep `ci.yml` and its existing changed-surface selectors as the single validation authority | Full-suite, browser, generated-contract, security and migration gates |
| Candidate/build | Extract repeated candidate/SHA checks and image/digest receipt handling from `deploy-dev.yml`, `deploy-uat.yml`, `deploy-production.yml` into existing deployment helpers | Immutable provenance; environment-specific frontend build configuration; exact-SHA CI |
| Rollout/readback | Share revision, traffic, schema, health and rollback-receipt handling | Each environment's approvals, capacity decisions, worker fences and recovery prerequisites |
| Dev-only machinery | Remove duplicate implementations after all callers use the common helpers; retain a thin governed environment entrypoint where dispatch contracts require it | Existing main-owned dev dispatch; branch qualification; preview isolation |
| Erasure parity | Apply the account-deletion fence and rollback-boundary proof to dev when the same migration boundary applies | UAT/production backup, deletion policy and writer-drain checks |
| Pod publication | Graduate the existing image/release owners explicitly; current build recipe publishes pod images only for dev | Separate dev/stable channels, exact predecessor recovery, signed immutable offers and owner approval |

Thin environment entrypoints may remain for GitHub permissions and dispatch
compatibility. They must call the common implementation rather than carry their own
copy. Delete obsolete references, selectors, tests and runbook commands together.
Normal application deployment and owner-pod installation remain separate operations.
After an authorized main rollout, reconcile GitHub registry entries for deleted
workflow files against main, active callers and recent runs. Disable only confirmed
obsolete entries, preserving historical run evidence and platform-managed security.

Before editing workflows, record a responsibility diff and identify each duplicated
block being replaced. Extend existing workflow/selector tests with negative controls
for wrong SHA, wrong environment, skipped validation and missing rollback evidence.
A shorter YAML file or a matching elapsed time is not a verification result.

## 3. Migrate people without changing their authority

| Cohort | First boot behavior | Required check |
| --- | --- | --- |
| Completed legacy Shared | Continue on Shared; retain existing information and supported connections | Migration 405 captures only the evidenced cohort once; replay cannot enroll later accounts |
| Existing BYOC | Preserve assignment, cloud, AI choice, keys, resources and selected hosting size | Registry/incarnation and pending operation remain unchanged |
| New user | Complete hosting selection, then one provider-aware AI step | No implicit Shared selection or duplicate AI wizard |
| Pending, detached or unknown placement | Resume recorded setup or ask for placement | No silent fallback to Shared or second cloud project |
| Returning updated user | Show concise, human release notes after authentication/setup resolves | Known pre-publication account, per-owner acknowledgement and cross-tab deduplication |
| New user at current release | Complete onboarding without a catch-up changelog | New/unknown account dates cannot establish the returning-user audience |

Use the existing choice and continuity migrations (402/405), their owning manifest
and schema contracts. The header in 405 also records predecessor foundation ordering;
reconcile it with the actual environment ledger before scheduling. Never rename or
replay an already-applied migration to make the manifest appear aligned.

`managed-app-release.ts` currently publishes catch-up notes only on the two dev
origins. UAT/production need their own reviewed publication metadata and copy;
changing a URL alone does not establish an eligible audience. Reuse
`AgentReleaseNotifier` and its owner-scoped acknowledgement. Pod completion notes
require a verified update receipt, independently of the managed-app announcement.

## 4. Make capability boundaries obvious

| Capability | Shared | Owner private pod |
| --- | --- | --- |
| AI | Hussh-managed Gemini and currently supported owner-key choices | Verified connection matching the selected cloud or explicit owner credentials |
| Files | Browser-encrypted explorer; unlocked foreground management and approved selected-file processing | Admitted encrypted library; qualified background organization after opt-in |
| Puppy | Unavailable | BYOC only, exact trusted-device grant and signed owner/pod binding |
| Software updates | Managed service version and release notes | Exact-release approval, durable progress, recovery and installed-digest verification |
| Recorded voice | Existing Shared contract | GCP's authorized native path; Azure disabled |
| Browser | Unavailable for persistent private work | Native sandbox only; unavailable per cloud until isolation qualifies |
| Scheduled private work | Explain the private-pod requirement | Only supported, qualified task types; no implied general cron capability |

Use authoritative placement/capability observations in onboarding, Settings, chat
and navigation. Enforce the same policy server-side. Preserve last verified state
while refreshing; offline, stale, incompatible and permission-denied are not ready.

## Promotion and stop conditions

1. **Local review:** resolve integration seams and verify source, generated contracts,
   cohort predicates, announcements, lifecycle cleanup and workflow responsibilities.
2. **Dev:** later authorized exact-SHA validation/deployment, serving readback, then
   separately approved pod updates and the affected owner journeys.
3. **UAT:** separate authorization; rehearse legacy/new/BYOC/pending cohorts, billing
   return, Files integrity, update interruption, connector revocation and account
   erasure. Prove retained information recovery and cloud-resource reconciliation.
4. **Production:** separate approval after UAT, capacity, migration/release-channel
   graduation, provenance, recovery, erasure and rollback-boundary evidence pass.

Current external failures remain explicit: GCP native owner-project AI returns 403;
Browser's native execution gates have not passed; retained synthetic erasure and
current-image journeys still need live receipts. Do not manufacture a pass, default
owners to Shared, weaken isolation or publish a stable offer to remove a blocker.
