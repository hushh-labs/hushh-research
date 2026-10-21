# Private agent: normal release transition

**Status:** authorized execution, refreshed 2026-10-21 UTC. Continue on the
infrastructure branch; preserve concurrent work and the active ADK tree. Prior
main/ADK integration remains preserved. Main through `04402b50d3` and frozen ADK `914e7c044c` are integrated through
`cb36d8a2ee`. Main's messaging and Azure managed-provider selection is preserved alongside
private-pod admission, Browser phase history and release publication. Nine peer
edits and the active ADK worktree remain unchanged.

One and Browser share the owner's image, container, non-root identity and
lifecycle. GCP remains Cloud Run with Chromium's sandbox enabled; Azure remains
Container Apps with it explicitly disabled. The whole owner pod is the compromise
boundary. No VM migration, separate Browser service or artificial keepalive.

The same immutable component image now produces real public-page frames and
confirmed supervisor shutdown on both services. Native model execution, owner
approval/takeover/login/reconnect, delivery, capacity and installed acceptance
remain separate gates. The [readiness memo](../../reference/quality/adk-orchestration-docs-audit.md)
owns current source and serving evidence; qualification does not enable a pod.

Fresh main/ADK source intake is complete. The local core mirror is complete; targeted repairs preserve its original failures.
Remaining execution order: corrected exact-SHA hosted CI → governed image build → measured common capacity
and agreed core lifecycle → exact-image qualification → governed metadata publication → exact owner installations → combined acceptance → **Admin SOP main merge and
landed-SHA validation/dev receipt**. Main integration is now explicitly authorized
after those gates. UAT/production, stable publication and automatic owner upgrades
remain unauthorized. General scheduled-task expansion and coding activation are
outside this Browser-plus-core gate; preserve supported schedules.

GCP dev uses the approved personal Gemini bridge because native organization AI
is restricted. More IAM grants cannot repair the recorded provider dunning denial.

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
The local consolidation removes copied Codex skill discovery, moves settings,
routing cases and pinned imports into `.agents`, and checks exact native links.
Peer MCP definitions and the active ADK worktree are preserved. Existing owner
resources, product agents and release authority are unchanged.

## 1. Finish and freeze the source

- Main through `04402b50d3` is integrated by `cb36d8a2ee`, preserving its
  Profile/mobile, consent, deletion, PLG, Calendar and migrations 365–369 alongside
  pod authority. New content routes retain Shared-only admission; signed PLG
  operational exports retain their separate bounds and disabled defaults. The
  managed Azure provider update keeps its required admission aggregate. One Vertex
  probe records its actual result before cleanup; UAT evaluates both providers,
  while other environments retain predeployment Vertex refusal. Messaging keeps
  main's photo, contact, voice and touch behavior alongside owner-bound drafts,
  pinned attachment authority and late-result fencing.
- Frozen ADK `914e7c044c` is integrated by `47bc0245d7`. Its native Profile
  preparation and visit fencing retain lazy plugin registration, current public-
  profile forms, pod AI selection and owner controls. Regenerate projections
  from this committed ancestry. Retain the earlier integration receipts as
  history; neither old CI nor component probes qualify the combined candidate.
- Keep unrelated PDF, native dependency and tooling edits outside the release.
  Freeze one dependency-complete revision after these seams are resolved.
- Run affected contract checks while implementing. Run the local core mirror once
  on that final revision, then one hosted PR validation on the authorized
  branch push. Re-run a failed job; do not push repeatedly to monitor CI.

## 2. Consolidate the existing release path

Local cleanup removes the two duplicate pod-only scheduled workflows and standardizes
13 display names. Normal Protocol CI retains both core suites. See the
[workflow catalog and timing review](../../reference/operations/ci.md#workflow-catalog-and-naming).
Core gate names, deployment authority and capacity tick titles are unchanged.

All three workflows already share `resolve-deploy-scope.py`, Cloud Build templates,
immutable image handling and revision-provenance helpers. Consolidate measured
remaining duplication in those owners; do not create a second release authority.
The extraction table is the remaining consolidation roadmap; it does not make
every unmeasured helper extraction a prerequisite for the exact-SHA acceptance gate.

| Surface | Proposed change | Preserve |
| --- | --- | --- |
| PR validation | Keep `ci.yml` and its existing changed-surface selectors as the single validation authority | Full-suite, browser, generated-contract, security and migration gates |
| Candidate/build | Extract repeated candidate/SHA checks and image/digest receipt handling from `deploy-dev.yml`, `deploy-uat.yml`, `deploy-production.yml` into existing deployment helpers | Immutable provenance; environment-specific frontend build configuration; exact-SHA CI |
| Rollout/readback | Share revision, traffic, schema, health and rollback-receipt handling | Each environment's approvals, capacity decisions, worker fences and recovery prerequisites |
| Dev-only machinery | Remove duplicate implementations after all callers use the common helpers; retain a thin governed environment entrypoint where dispatch contracts require it | Existing main-owned dev dispatch; branch qualification; preview isolation |
| Erasure parity | Apply the account-deletion fence and rollback-boundary proof to dev when the same migration boundary applies | UAT/production backup, deletion policy and writer-drain checks |
| Pod publication | Graduate the existing image/release owners explicitly; current build recipe publishes pod images only for dev | Separate dev/stable channels, exact predecessor recovery, reviewed digest-pinned offers and owner approval |

Thin environment entrypoints may remain for GitHub permissions and dispatch
compatibility. They must call the common implementation rather than carry their own
copy. Delete obsolete references, selectors, tests and runbook commands together.
Normal application deployment and owner-pod installation remain separate operations.
The local predecessor-acceptance helper requires a healthy dev receipt for the
exact application SHA and resolved services before UAT; production requires UAT
acceptance with its dev chain for both source builds and image promotion. Receipts
bind successful main-owned workflow attempts, immutable artifact digests, final
serving revisions, schema checks and existing health classifications. Advisory
findings retain their existing policy. A landed merge SHA needs its own dev
acceptance; a branch receipt cannot substitute. This operations change is prepared
locally and is not active until separately authorized on main.
Receipt discovery retains successful earlier attempts when a later rerun fails;
every selected artifact still requires its own successful attempt and exact
application SHA, services, digest and serving evidence.
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

Use the existing choice and continuity migrations (402/404/405), their owning
manifest and schema contracts. Verified ADC readback on 2026-10-20 found 955/958
already applied on dev with unchanged source checksums; 405 is unapplied in dev,
UAT and production. UAT has a ledger but no hosting-choice columns; production
has neither the migration ledger nor pod registry. Inspect again before rollout.

The local 405 correction excludes retained cloud and pod-signing fields, matching
runtime eligibility. New dev-only 965 repairs only incompatible **inferred**
Shared choices whose choice timestamp still matches the legacy receipt. It keeps
the receipt and preserves explicit later choices, BYOC assignments and pending
setups. Sixty focused PostgreSQL/manifest checks pass. No live migration ran.
Never rewrite the applied 958 migration or infer that ledger readback proves
every owner's placement.

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
| Browser | Unavailable for persistent private work | Same owner container; explicit GCP sandbox-on / Azure sandbox-off qualification, owner policy and installed acceptance |
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

Local Puppy and Scheduled tasks entry points now check canonical placement before
requesting private execution. Browser rediscovery preserves known task cards and
offers a bounded reconnect action after a requested task; an ordinary Shared visit
does not display a failed private discovery request. These focused UI checks pass,
but they are not deployed. The unavailable Browser tool still needs its attempted-
action explanation through production capability composition.

## 5. Complete built-in Browser independently on GCP and Azure

**Neither installed owner Browser journey is complete.** Both ordinary hosting
services now pass synthetic browsing and joined process shutdown under the shared
owner boundary. Historical protected-process and VM evidence remains historical;
no owner hosting migration follows from it.

The [runtime reference](../../../consent-protocol/docs/reference/private-browser-runtime.md)
owns exact mode, image, model, authority and lifecycle contracts. Before release:

1. Compose the actual native model, exact reviews, selected-information/session
   ports, Browser work delivery and bounded Files transfer. Prove research,
   takeover, login observation suppression, handback, reconnect and Stop on each
   cloud without goal replay or uncertain-effect replay.
2. Compare the same candidate at 1 vCPU / 2 GiB and 2 vCPU / 4 GiB. Choose the
   smallest common passing configuration with measured headroom. Keep existing
   owner resources until an exact configuration/update approval. Capacity does
   not change minimum-zero sleeping policy; scratch is separately budgeted.
3. Use two runs of the existing main-owned `deploy-dev.yml`, not another workflow:
   **A:** remove the old image-reuse pin, validate the complete
   source SHA, then dispatch `build_pod_image=true` (`scope=all` for frontend changes).
   This builds and archives the immutable image and deploys the backend; Browser
   remains unavailable. Qualify that exact image/source on each host. **B:** commit
   reviewed version-2 receipts, the assembler's Browser-qualification checksum pins
   and a new reuse pin naming A's image/source/run/archive checksum. Obtain exact-SHA
   CI for B, then dispatch the same workflow with `scope=backend` and
   `build_pod_image=true`. It publishes qualified dev metadata without rebuilding
   the pod; both runs are governed backend deployments. Verify recovery,
   drain, digest, policy and serving readback through the existing owner approval
   flow. Image-only approval never grants Browser activation or larger capacity.
4. Keep unavailable controls hidden, with useful explanations on attempted use.
   Shared continuity, exact BYOC placement and existing information stay intact.

The future workspace contract covers bounded scratch/cache, periodic encrypted
checkpoints, revision references, restart, cancellation and erasure. No general
shell or coding workload is enabled by this release.

## Promotion and stop conditions

1. **Local review:** resolve integration seams and verify source, generated contracts,
   cohort predicates, announcements, lifecycle cleanup and workflow responsibilities.
2. **Dev:** exact-SHA image build, exact-image qualification and validated metadata
   publication as above; serving readback, separately approved pod updates and the
   affected owner journeys.
3. **Main:** reviewed PR and ordinary merge queue under Admin SOP after dev acceptance.
   Use an Admin bypass only under explicit authorization and the same verified gates.
   Require the exact landed SHA's Main Post-Merge Smoke and its distinct dev receipt,
   then synchronize the preserved infrastructure branch.
4. **UAT:** separate authorization; rehearse legacy/new/BYOC/pending cohorts, billing
   return, Files integrity, update interruption, connector revocation and account
   erasure. Prove retained information recovery and cloud-resource reconciliation.
5. **Production:** separate approval after UAT, capacity, migration/release-channel
   graduation, provenance, recovery, erasure and rollback-boundary evidence pass.

Current gaps remain explicit in the readiness memo. Do not manufacture a pass,
default unknown owners to Shared, silently change capacity or cloud, or publish a
stable offer to bypass a gate. The accepted shared-owner boundary must not be
misrepresented as Browser-to-One process isolation.
