# UAT Scoped Deploy Proof

## Scope Decision

Use the smallest deploy scope that covers the diff.

1. `frontend`: `hushh-webapp`, Next.js routes, auth gates, UI, frontend env, or frontend Cloud Build only.
2. `backend`: `consent-protocol`, API behavior, migrations, backend env, or backend Cloud Build only.
3. `all`: shared deploy contracts, both runtime images, schema plus UI changes, or unknown cross-surface risk.

If a previous run accidentally used `scope=all`, name that as evidence drift and trigger the next run with the exact scope.

## Deploy Command

Use a green `main` SHA:

```bash
gh workflow run deploy-uat.yml --ref main -f scope=<frontend|backend|all> -f sha=<main-sha>
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
