---
name: uat-scoped-deploy
description: Use when choosing, running, or verifying scoped UAT deploys for Hussh Cloud Run services, including frontend-only/backend-only scope, Cloud Build timing proof, Cloud Run region discovery, and service provenance evidence.
---

# Hussh UAT Scoped Deploy Skill

## Purpose and Trigger

- Primary scope: `uat-scoped-deploy-scope`
- Trigger on choosing, running, or verifying a scoped UAT deploy for Cloud Run services.
- Avoid overlap with `repo-context`, broad `repo-operations`, and product implementation owner skills.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `repo-operations`

Owned repo surfaces:

1. `.github/workflows/deploy-uat.yml`
2. `deploy`

Non-owned surfaces:

1. `repo-operations`
2. `frontend`
3. `backend`
4. `security-audit`

## Do Use

1. UAT deploys where `scope=auto` resolves `frontend`, `backend`, or `all` from target-to-deployed-service baselines.
2. Cloud Build timing, skipped-lane, and deploy summary proof.
3. Cloud Run service evidence: project, region, revision, image, timeout, env, traffic, and request-id logs.

## Do Not Use

1. Production deploys unless the user separately asks for production.
2. Product code fixes after deploy verification exposes a frontend/backend bug.
3. Broad CI or release-governance questions not narrowed to UAT deploy scope.
4. Manual browser-only acceptance without runtime or log evidence.

## Read First

1. `.github/workflows/deploy-uat.yml`
2. `deploy/README.md`
3. `deploy/frontend.cloudbuild.yaml`
4. `deploy/backend.cloudbuild.yaml`
5. `docs/reference/operations/branch-governance.md`
6. `.codex/skills/repo-operations/references/admin-release-sop.md`
7. `.codex/skills/uat-scoped-deploy/references/deploy-proof.md`
8. `.codex/skills/uat-scoped-deploy/references/anti-rationalization.md`

## Workflow

1. Default to `scope=auto`; let the resolver compare the target SHA with each service's currently deployed SHA and record both requested and resolved scope.
2. Force `frontend`, `backend`, or `all` only after target-to-deployed-service delta proof establishes that the override covers every accumulated runtime change.
3. Use `admin-release-sop.md` for the queue-first path and any explicitly authorized Admin PR landing; do not duplicate or reinterpret its exact-head authority gate here.
4. Wait for `Main Post-Merge Smoke` to succeed for the landed `main` SHA, then trigger UAT with that exact SHA. Keep merge, smoke, and UAT deploy as separate evidence.
5. Watch the GitHub run until terminal success or a concrete blocker; confirm skipped lanes from run steps.
6. Before Cloud Run `describe`, run the evidence helper to discover the actual project/region tuple.
7. Capture touched-service revision, image, labels, timeout, traffic, env contracts, request IDs, and logs.
8. Report run URL, scope, skipped lanes, timings, revisions, and remaining risk; never call queued work done.
9. Read the `uat-verification-plan` artifact from the exact changed-SHA selector. PKM upgrade rehearsal and candidate evaluator are required only for PKM upgrade/storage/migration contracts; reviewer BYOK is independently selected for vault/reviewer contracts. A missing deployed SHA fails closed. Never replace this selector with a workflow-local path list.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `repo-operations`.
2. Route frontend implementation bugs to `frontend` after preserving deploy evidence.
3. Route backend/API contract bugs to `backend-api-contracts` or `backend`.
4. Route auth, secret, or consent boundary findings to `security-audit`.

## Required Checks

```bash
gh run list --workflow deploy-uat.yml --limit 5 --json databaseId,status,conclusion,headSha,event,url
python3 .codex/skills/uat-scoped-deploy/scripts/cloud_run_service_evidence.py --project hushh-pda-uat --service hushh-webapp --service consent-protocol --format text
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
```
