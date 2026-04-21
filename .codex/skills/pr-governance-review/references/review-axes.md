# PR Review Axes

Use these axes in order. A green gate does not clear a PR if any blocker remains here.

## 1. North-Star Alignment

- Does the change make the repo leaner, clearer, and more scalable?
- Does it preserve consent-first, trust-boundary clarity, and local-first contributor ergonomics?
- Does it remove friction or add invisible complexity?

## 2. Trust Boundary Integrity

- Are auth, vault, consent, PKM, Gmail, Plaid, Firebase, or role surfaces changed?
- Does the caller still provide the correct credential or token shape?
- Is one header or state channel now asked to carry two incompatible identities?

## 3. Contract Symmetry

- If a backend route changes, did the frontend caller or Next proxy change too?
- If the runtime contract changes, did bootstrap, docs, and tests move with it?
- If event semantics change, do clients still interpret them correctly?

## 4. Main Overlap and Architecture Path Integrity

- Does `main` already implement the concept in a different file family or route family?
- Is the PR adding a second architecture path for the same product concept instead of extending the canonical one?
- Is the right outcome `patch_then_merge` or `block` even though exact file overlap is zero?

## 5. Deploy and Runtime Integrity

- Did the PR change Docker, deploy YAML, CI, runtime entrypoints, or package install paths?
- Are new runtime dependencies pinned in the real dependency surface instead of injected ad hoc?
- Does the change make builds more reproducible or less reproducible?

## 6. Proof Quality

- Are there targeted tests or contract checks for the changed behavior?
- Did the PR only make the existing gate green, or did it prove the new behavior?
- Are stale runs or old comments being mistaken for the current head state?

## 7. Malicious or Low-Signal Degradation Signals

- `.gitignore` expanded around credentials, secrets, generated artifacts, or local scripts
- auth tightened or widened without matching caller changes
- “performance” changes that alter semantics, latency visibility, or observability
- runtime dependency added in Docker or CI without manifest ownership
- docs/tests omitted on a sensitive contract change
- public ingress added without explicit rollout and abuse-control proof
- a second product surface added when `main` already has the concept

## Decision Rule

- Block merge if any high-severity finding remains.
- Do not thank, approve, or recommend merge while blockers remain.
- For `merge_now` and `patch_then_merge`, always prepare the contributor-facing acknowledgment draft before the merge action.
- Post that note only after the monitored merge path reaches the required terminal state.
- Once this policy is in force, do not require an extra confirmation step for posting the note.
- When the merge affects a reusable subsystem or trust boundary, include a compact `Related Surfaces` section so the PR history points to the canonical files and higher-level docs that define the surrounding contract. Prefer clickable GitHub links when the target can be resolved safely, and add a one-line reason for every linked entry.
- If the contributor is correct about a repo-side CI bug, say so explicitly and separate that from code safety.

## Merge Lanes

Use one of these three lanes after the review:

### 1. `merge_now`

Use only when:
- current head SHA is green
- no blocker findings remain
- any residual risk is low and already documented by the existing contract

### 2. `patch_then_merge`

Use when:
- the direction is good
- the findings are bounded and maintainer-fixable
- merging the contributor head directly would still be unsafe

Typical examples:
- backend contract changed without matching caller updates
- auth tightening is directionally right but only one side moved
- runtime/deploy improvement is reasonable but not yet pinned or documented

Execution rule:
- do not merge the unsafe contributor head
- if maintainers can modify the contributor branch, patch that branch directly
- otherwise create a short-lived branch named `temp/pr-<number>-patch`, apply the fix there, and delete it after the issue is resolved
- rerun CI on the updated merge candidate
- then thank the author and explain what was integrated and what was corrected

### 3. `block`

Use when:
- the change is broad, unclear, or unsafe
- the findings are not bounded enough for a small maintainer patch
- the PR weakens repo governance, trust boundaries, or contributor safety
