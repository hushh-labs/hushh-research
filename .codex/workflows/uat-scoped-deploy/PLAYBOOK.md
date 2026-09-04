# UAT Scoped Deploy

Use this workflow pack when the task matches `uat-scoped-deploy`.

## Goal

Run the smallest safe UAT deploy scope and prove the result with GitHub Actions, Cloud Build, Cloud Run, and behavior evidence.

## Steps

1. Start with `repo-operations`; use `uat-scoped-deploy` after the task is narrowed to UAT deploy scope.
2. Default to `scope=auto`; record the resolver's requested and resolved scope against each service's currently deployed SHA. Force a narrower or broader scope only with target-to-deployed-service delta proof.
3. Follow `.codex/skills/repo-operations/references/admin-release-sop.md` for queue/Admin authority, then trigger `deploy-uat.yml` only from its exact green landed `main` SHA.
4. Treat the standalone `consent-protocol` repository as an optional mirror. Its sync, push, and CI state must never block a monorepo merge, post-merge smoke, or UAT deploy.
5. Watch the run to terminal state and record skipped deploy lanes from the job steps.
6. Discover Cloud Run service regions with the helper before any `gcloud run services describe`.
7. Capture revision, image, timeout, traffic, labels, and key env contracts for touched services.
8. Run the relevant live smoke or request-id/log proof before calling the deploy verified.

## Common Drift Risks

1. Forcing a scope without proving the full target-to-deployed-service delta; an automatic resolution to `all` is valid when both services have accumulated changes.
2. Assuming `us-central1` or another region before listing actual service tuples.
3. Blending merge proof, deploy proof, and runtime behavior proof into one status.
4. Stopping at deploy green when the user asked for end-to-end UAT behavior.
5. Delaying a monorepo release to repair or publish the optional standalone mirror.
