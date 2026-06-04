# UAT Scoped Deploy

Use this workflow pack when the task matches `uat-scoped-deploy`.

## Goal

Run the smallest safe UAT deploy scope and prove the result with GitHub Actions, Cloud Build, Cloud Run, and behavior evidence.

## Steps

1. Start with `repo-operations`; use `uat-scoped-deploy` after the task is narrowed to UAT deploy scope.
2. Classify the smallest safe scope: `frontend`, `backend`, or `all`.
3. Trigger `deploy-uat.yml` from a green `main` SHA with the explicit scope and SHA.
4. Watch the run to terminal state and record skipped deploy lanes from the job steps.
5. Discover Cloud Run service regions with the helper before any `gcloud run services describe`.
6. Capture revision, image, timeout, traffic, labels, and key env contracts for touched services.
7. Run the relevant live smoke or request-id/log proof before calling the deploy verified.

## Common Drift Risks

1. Falling back to `scope=all` for small frontend or backend changes.
2. Assuming `us-central1` or another region before listing actual service tuples.
3. Blending merge proof, deploy proof, and runtime behavior proof into one status.
4. Stopping at deploy green when the user asked for end-to-end UAT behavior.
