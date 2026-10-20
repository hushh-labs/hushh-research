# Private agent: normal release transition

**Status:** local integration plan, refreshed 2026-10-19. Main `f47a4832dbc` and
frozen ADK `42bb9823005` are integrated through `b14bc29901`; the current local
checkpoint is `fd4770c16e`. The approved Browser-first implementation permits
exact-SHA validation and governed dev acceptance after the candidate is complete.
Application main merge, UAT/production and stable publication remain separate.
The [readiness memo](../../reference/quality/adk-orchestration-docs-audit.md) owns
actual journey acceptance; this plan does not convert source checks into live proof.

## Visual Context

Use the [CI delivery map](../../reference/operations/ci.md) for the existing
validation and deployment owners. This proposal changes their composition while
preserving environment authority and the separate owner-pod installation flow.

## Decision

Use the normal PR validation and release machinery for the private agent. Dev,
UAT and production share one implementation of candidate selection, build,
verification, rollout receipts and failure settlement. Keep explicit environment
policy: dev can qualify an exact green branch revision; UAT and production require
a reviewed green main revision and their existing release authority.

Existing BYOC owners stay on their assigned pod. Eligible legacy Shared users
continue on Shared without a new cloud setup. Unknown placement stays explicit.
Hub deployment never installs an owner-pod image.

The [repository organization plan](../repository-organization-plan.md) adds the
requested canonical `.agents/` migration, bounded folder consolidation and linked
documentation cleanup. It preserves this plan's implementation and release gates;
neither a cleaner tree nor passing documentation checks proves pod readiness.

## 1. Finish and freeze the source

- Fresh main is integrated locally. Preserve pod authorization, bounded streams,
  reconnect/resync, connector route registration and current Profile behavior.
- Preserve the active ADK worktree. The frozen `42bb9823005` delta is integrated
  with authority reconciliation: extracted AI settings retain Azure-aware
  pod selection and key readiness; device models must retain Puppy grant and
  revocation; Memory must retain identifier-processing consent and sharing controls;
  World Model writes retain owner-current and abort checks. Regenerate
  projections from the merged authored owners. Integrate the later dependency-relevant
  delta once after implementation; preserve the existing verified integration evidence.
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

### Shared defaults and unavailable-state copy

**Required UX, reviewed 2026-10-19; not a claim that every message is implemented.**
Shared retains managed Gemini chat, currently supported owner-key choices, encrypted
memory, consent and existing connected tools under their current contracts. Do not
disable existing consented mail scheduling or platform background infrastructure
because new autonomous private work needs a pod. Shared voice follows its existing
capability contract; Azure recorded voice remains disabled independently of Shared.

| Unavailable in Shared | Concise message and behavior |
| --- | --- |
| Puppy / trusted-machine inference relay | “Puppy needs your own cloud.” Offer Hosting; no device grant or relay request from Shared. Trusted-device identity alone never enables Puppy. |
| Agent-operated browser, live browser takeover and remembered browser logins | “Browser tasks aren't available on Shared.” Explain the cloud qualification requirement on demand; do not imply creating a pod immediately enables Browser. |
| Automatic library organization or private analysis after the owner leaves | “Automatic organization needs a private agent.” Keep supported selected-file foreground analysis separate, with explicit consent. |
| New scheduled private goals requiring continued information access | “This task needs a private agent to run later.” Do not accept an unsupported schedule, or promise that any arbitrary task can run on a pod. |
| Dedicated pod compute, sleeping/waking controls and personal cloud resources | “You're using Hussh's shared runtime.” Offer hosting selection only; never fabricate a personal pod status or silently provision one. |
| Owner-installed pod image updates or restarts | “Hussh keeps this runtime updated.” Show the managed version and appropriate changelog; hide Install/Restart controls. |
| Automatic access through an owner's Vertex/Azure workload identity | “Connect your own cloud to use its AI.” Preserve supported explicit owner-key choices; never label Shared AI as the owner's cloud connection. |

Files is not categorically pod-only: the Shared encrypted explorer and selected
foreground analysis are a **dev pilot**, require their existing flags/schema and
consent, and are not yet a UAT/production promise. Where not enabled, show
“Files isn't available in this environment yet.” Do not misdirect these owners
to buy hosting to resolve an environment rollout gate. Analysis also retains its
current selected-format/size limits; hide unsupported bulk/background controls.

Shared-to-pod, reverse and cross-cloud Files transfers remain unavailable. If a
library blocks hosting change, preserve it and say “Moving your files to another
runtime isn't available yet.” Do not offer a hosting shortcut that bypasses the
library fence or implies a qualified migration.

Use a short inline explanation at the attempted action, one relevant next action,
and optional details. Hide unavailable execution controls from primary navigation;
typed requests and direct routes must still return a useful refusal. No recurring
upgrade nag, permanent error card or endless spinner. Keep unavailable, not
connected, permission denied, temporarily offline and still checking distinct.
Derive these states from existing placement/capability contracts and reason codes,
not from display labels or a second capability registry. Protect the same refusal
server-side and verify Shared, unplaced, pending and admitted pod cases.

One confirmed implementation gap is Browser's Shared presentation: absent admission
currently becomes the generic cloud-gate refusal, and task discovery renders no
tasks. Wire the explanation into the existing capability surface; an unused
unavailable component or silently hidden task list does not satisfy this UX.

## 5. Complete built-in Browser independently on GCP and Azure

**Current truth at `6178eea2c0` plus the local guarded-process slice, reviewed 2026-10-20 UTC: neither cloud is complete.**
The [browser runtime owner](../../../consent-protocol/docs/reference/private-browser-runtime.md)
records local authority, preview, responsive controls and remembered-session tests.
The product manifest still withholds discovery and disables exposure. Browser
bindings and ingress are dev-only. `BrowserReadiness.require_ready()` requires
verified isolation, denied direct egress, a private ephemeral bridge and native model
transport; an administrator login, policy readback or local Chromium fixture cannot
issue those receipts.
The pod currently mounts Browser routes without installing `browser_task_runtime`;
complete qualified runtime composition rather than merely exposing a start button.

| Cloud | Recorded blocker | Next bounded proof |
| --- | --- | --- |
| GCP | An ordinary Gen 2 Job passes inherited network-syscall denial but returns `ENOSYS` for the proposed Landlock filesystem guard | Qualify equivalent private-file protection and actual sandboxed Chromium in the pod service, then its broker and lifecycle |
| Azure | The ordinary application passes separate-UID filesystem/network controls, including Unix datagram refusal. User namespace creation returns `EPERM` before our guard; sandboxed Chromium has produced no frame | Obtain an actually supported Chromium sandbox path in the same service; do not infer it from successful process protections |

The owner approved Browser inside the existing pod image and service, replacing
the requirement to use separate provider-managed sandbox products. Retain actual
Chromium sandboxing and owner/pod secret protection. Earlier native-probe failures
remain historical evidence; neither they nor the new process controls qualify a
working browser. Recheck supported provider behavior before a changed-prerequisite
probe rather than repeating unchanged failures.

Implementation order, owned by the existing backend/browser and operations lanes:

1. **Resolve built-in execution:** qualify identity, sandboxed Chromium, a synthetic
   frame, denied metadata/private/direct-public access and exact teardown separately
   per cloud. Use disposable resources, bounded runtime and no owner information.
   Keep Chromium's sandbox and verified process restrictions; no privileged or unsandboxed fallback.
2. **Complete private transport and composition:** supply real cloud adapters behind
   the existing execution port, broker, task runtime and action authority. Azure's
   current probe explicitly cannot issue a private-bridge readiness receipt. Probe
   stdout, provider filesystem APIs and policy configuration alone are insufficient.
   Keep task scratch memory-backed and secrets out of the launcher and telemetry.
3. **Connect One and owner control:** preserve ADK delegation, exact owner/incarnation
   checks, separate screen-processing/disclosure approvals and bounded tasks. Prove
   responsive viewport resizing with mouse, touch, keyboard and scrolling; reject
   stale coordinates, fence agent actions before takeover, suppress observations
   during login and require explicit handback with a fresh frame.
4. **Prove lifecycle:** reconnect to the same authorized task after app closure,
   cancel server-side, expire idle previews, checkpoint safely and drain on update.
   Verify remembered-login opt-in, Forget races and encrypted recovery. Lost effects
   remain uncertain and cannot be replayed. Test file transfer through its existing
   scoped Files owner; do not grant the sandbox ambient library access.
5. **Accept exact images:** after focused local checks, qualify both installed cloud
   images through governed dev release and exact owner approval. Exercise research,
   manual login, reviewed submission, takeover/handback, byte-verified download,
   restart, idle release and wake. Record stage timings, preview latency, resources
   and provider failures. Enable only the adapter whose full evidence passes.

Browser completion requires the installed-image journeys on **both** clouds.
Organization work can proceed independently, but cannot turn this unresolved
capability into a readiness claim. A failed native prerequisite stays a named
provider or integration blocker, with “Browser isn't available on this cloud yet”
and no nonfunctional launch button. Neither a flag change nor administrator access
is an acceptable substitute for the missing execution proof.

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
