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

Follow `.codex/skills/repo-operations/references/admin-release-sop.md` for the
ordinary merge-queue path or an explicitly authorized Admin PR landing. This
spoke owns UAT scope and proof after that authority contract yields an exact
green landed `main` SHA; it does not redefine merge or bypass semantics.

Use the resulting green `main` SHA:

```bash
gh workflow run deploy-uat.yml --ref main -f scope=auto -f sha=<main-sha>
```

Then watch:

```bash
gh run watch <run-id> --exit-status
```

## Required Evidence

1. GitHub run URL, SHA, scope, and conclusion.
2. Step proof that untouched lanes were skipped.
3. Cloud Build duration for each executed lane.
4. Cloud Run service tuple from discovery: project, service, region.
5. Latest ready revision, traffic split, image tag, deploy SHA label, GitHub run label, timeout, and key env values.
6. Live behavior proof for the changed surface, including request IDs and logs for API/runtime fixes.

## Region Tuple Guard

Never run `gcloud run services describe <service> --region <assumed-region>` as the first proof command.

Run:

```bash
python3 .codex/skills/uat-scoped-deploy/scripts/cloud_run_service_evidence.py --project hushh-pda-uat --service <service> --format text
```

If the helper cannot find the service, list services in the project and stop with a blocker instead of switching regions by guesswork.
