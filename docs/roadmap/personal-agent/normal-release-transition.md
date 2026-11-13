# Private-agent release transition

[Private-agent roadmap](README.md) · [Release control](../../operations/releases/ci.md)

This plan retains unfinished private-agent acceptance. It does not introduce a
second CI policy or authorize deployment, owner installation or feature activation.
The [Admin SOP](../../../.agents/skills/repo-operations/references/admin-release-sop.md)
owns current release authority; historical execution sequences remain in Git.

## Visual Context

Use the [hosting module](../../architecture/modules/hosting.md) and
[Browser module](../../architecture/modules/browser.md) for runtime boundaries.
[Operational acceptance](../../operations/acceptance/private-agents.md) separates
source, application deployment and installed-owner evidence.

## Delivery boundaries

- Preserve existing owner assignments, pending setup, keys, resources and selected capacity.
- Shared continues as an explicit supported choice. Unknown placement is never Shared by default.
- Keep application release, immutable pod publication and owner-approved installation separate.
- Use trusted Main-owned workflows with the selected protected application history.
  Merges deploy nothing; UAT does not require a preceding Dev deployment, and
  current production admission does not require a preceding UAT deployment.
- Reconcile only the reviewed source delta downstream, preserving concurrent work.
- General scheduling expansion, coding execution, managed-hosting launch and
  cross-cloud information transfer keep their own gates.

## Existing-user continuity

| Cohort | Required outcome |
| --- | --- |
| Evidenced legacy Shared owner | Continue without repeating hosting; retain memory and supported connections |
| Existing BYOC owner | Preserve cloud, model choice, owner/incarnation, keys and resources |
| New owner | Hosting first, then one provider-aware AI step; no duplicate wizard |
| Pending setup | Resume the recorded operation; do not allocate a second project or service |
| Detached or unknown placement | Resolve the actual placement or request a choice |
| Returning eligible owner | One concise changelog with owner-scoped acknowledgement |
| Newly registered owner | Onboarding without historical catch-up announcements |

Use current migration manifests and installed ledgers. Preserve applied checksums;
forward corrections must distinguish inferred legacy choices from explicit owner
choices. Old migration numbers and historical readbacks are not deployment instructions.

Same-login registration uses the existing environment-local account-generation
authority. Start fresh requires settled cleanup and independently fresh identity
proof. Retired tombstones remain immutable; never recover ownership by email alone.
Drain old consumers and prove sessions, grants, callbacks, jobs, devices and writes
remain generation-bound before activating replacement generations. Account deletion
must not delete a shared production Firebase identity as a dev-side shortcut.

## Shared defaults and unavailable-state copy

Use authoritative placement and capability observations in onboarding, Settings,
chat and backend enforcement. Preserve last verified information while refreshing.
Keep unavailable, not connected, permission denied, offline and checking distinct.

| Attempted action | Required experience |
| --- | --- |
| Puppy on Shared | Explain that Puppy needs the owner’s cloud; offer Hosting without attempting a relay |
| Browser on Shared or unqualified pod | Explain the capability requirement on demand; do not imply provisioning immediately enables it |
| Background Files work | Preserve supported foreground analysis; explain the separate private-agent requirement |
| Unsupported private schedule | Refuse clearly without promising a general cron capability |
| Shared software update | Show managed version information; do not offer pod Install/Restart controls |
| Files unavailable in this environment | Explain the rollout limit; do not direct the owner to buy hosting for an environment gate |
| Hosting change blocked by a library | Explain that information transfer is unavailable; preserve the library and current placement |

Keep the explanation short, with one relevant next action. Hide unusable execution
controls from primary navigation; typed requests and direct routes still need a useful
refusal. Avoid persistent upgrade nags, permanent error cards and endless spinners.
Shared model labels follow the environment’s configured provider, independently
of hosting. Azure recorded voice remains disabled. See [capability availability](../../product/capabilities.md).

## Browser qualification

Reuse the existing ADK specialist, task state, broker, action ledger, encrypted
session storage and update lifecycle. One and Browser share a non-root owner
container: GCP Chromium sandbox enabled; Azure explicitly qualified disabled.
Do not claim Browser-to-One process isolation or compromised-code containment.

Before a cloud is offered Browser:

1. Qualify the exact immutable image, actual host, model transport and interactive policy.
2. Prove public research, preview, takeover, handback, reconnect and joined Stop
   without goal resubmission or uncertain-effect replay.
3. Prove manual-login observation suppression, opt-in remembered recovery and
   race-safe Forget, plus exact reviewed reversible actions on the same session.
4. Preserve one active task/page, the existing action/continuation bounds and
   owner control. Keep unsupported websites in intervention rather than bypassing
   anti-abuse controls.
5. Publish only recovery-qualified metadata, then install through exact owner
   approval. Verify active-work drain, restored state and the installed digest.

[Independent Dev publication](../../operations/hosting/dev-pod-first-light-runbook.md#independent-dev-pod-publication)
owns image preparation and coordinated catalog activation. A source patch or
synthetic component test does not establish an installed owner journey.

Selected PKM disclosure, Browser-to-Files downloads, broader website acceptance
and new capacity studies retain separate gates. Existing owners keep capacity
until approving an exact change. Future coding remains a workspace design topic:
bounded scratch/cache, periodic encrypted checkpoints, revision references,
restart recovery, cancellation and erasure; no unrestricted shell is enabled.

## Combined acceptance and stop conditions

Freeze a dependency-complete source candidate, regenerate affected contracts and
run the nearest authoritative core and changed-boundary checks. Complete the
explicitly authorized application release separately from pod publication.

Installed acceptance covers Browser on each cloud, current-image Files integrity
and organization, one Puppy/Gemma 12B answer with cancellation/reconnect, update
drain/recovery and repairable removal/deletion. Preserve uncertain provider outcomes;
a worker exit or failed cancellation does not prove provider termination.

Do not report source-only completion, a green aggregate or a fixture as installed
acceptance. No stable offer, automatic owner upgrade or production rollout follows
from this plan. Use the [acceptance record](../../operations/acceptance/private-agents.md)
and [existing delivery issue](https://github.com/hushh-labs/hushh-research/issues/5507)
for unresolved outcomes, not another competing status ledger.
