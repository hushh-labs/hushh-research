# UAT Scoped Deploy Proof

## Scope Decision

Default to `scope=auto`, which compares the target SHA with each service's
currently deployed SHA and covers accumulated changes when UAT lags multiple
merges. Record both requested and resolved scope.

Forced overrides require target-to-deployed-service delta proof:

1. `frontend`: every accumulated runtime change is frontend-only.
2. `backend`: every accumulated runtime change is backend-only.
3. `all`: both runtimes, shared deploy contracts, schema plus UI, or unknown cross-surface risk.

If a previous run used an unjustified forced override, name that as evidence drift and return the next run to `scope=auto` (or provide complete target-to-deployed-service delta proof for another override).

## Deploy Command

Follow `.agents/skills/repo-operations/references/admin-release-sop.md` for the
ordinary merge-queue path or an explicitly authorized Admin PR landing. This
spoke owns UAT scope and proof after that authority contract yields the
Main-owned workflow; it does not redefine merge or bypass semantics. New
application source must be an exact SHA in protected `uat` history. A
Main-only SHA is not a normal UAT source.

For a direct UAT candidate, inspect prerequisites from `main` first. In Actions,
select **Deploy to UAT → Run workflow → main → operation=inspect**, leaving
release inputs at defaults. This uses the governed UAT identity for read-only
serving observations, without a deployment record or runtime mutation. The
summary identifies protected tip, serving base and current CI status. Wait for
existing pending CI; investigate an existing failure before dispatching more CI.
Only when missing qualification is reported, run full PR Validation on `uat`
with the shown base. After success inspect again, then deploy with its exact
current CI run, attempt and comparison base. Ordinary UAT selects the protected
SHA directly; no manual PR-history chain or serving-commit ancestry is required.
Once selected, that frozen ordinary UAT SHA remains eligible after newer merges
while it remains in protected UAT history; CI, current authority and live-baseline
checks still apply. Never silently substitute the new tip. New deployments reject incomplete pins before
security/capacity jobs; security clearance and under-lock admission remain required:

```bash
gh workflow run deploy-uat.yml --ref main -f operation=inspect
gh workflow run ci.yml --ref uat -f scope=all -f uat_base_sha=<serving-uat-sha>
gh workflow run deploy-uat.yml --ref main -f scope=auto \
  -f sha=<validated-uat-sha> -f ci_run_id=<run-id> \
  -f ci_run_attempt=<attempt> -f ci_base_sha=<serving-uat-sha>
```

The locked release rechecks the exact candidate, current full-CI attempt, both
observed serving revisions, schema compatibility and qualified rollback. Different
frontend/backend serving SHAs are supported. Legacy `uat-isolated` recovery retains
its separately reviewed PR-scope contract. Production still requires UAT acceptance
and Main approval.

Then watch:

```bash
gh run watch <run-id> --exit-status
```

## Required Evidence

1. GitHub run URL, SHA, scope, and conclusion.
2. Step proof that untouched lanes were skipped.
3. Cloud Build duration for each executed lane, plus `frontend_image_wait` from
   the release status artifact (time the lane blocked on the parallel web image
   build) and the pinned `hushh-webapp@sha256:` digest the candidate runs.
4. Cloud Run service tuple from discovery: project, service, region.
5. Latest ready revision, traffic split, image tag, deploy SHA label, GitHub run label, timeout, and key env values.
6. Live behavior proof for the changed surface, including request IDs and logs for API/runtime fixes.

## Region Tuple Guard

Never run `gcloud run services describe <service> --region <assumed-region>` as the first proof command.

Run:

```bash
python3 .agents/skills/uat-scoped-deploy/scripts/cloud_run_service_evidence.py --project hushh-pda-uat --service <service> --format text
```

If the helper cannot find the service, list services in the project and stop with a blocker instead of switching regions by guesswork.
