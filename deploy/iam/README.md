# Production GitHub WIF

This directory owns the single setup path for GitHub Actions deployment
authentication into the `hushh-pda` production project.

## Canonical setup

Run from the repository root with authenticated `gcloud` and `gh` sessions:

```bash
bash deploy/iam/setup_production_github_wif.sh
```

The script is idempotent. It:

1. creates or reuses the dedicated production deploy service account
2. creates or reuses the production GitHub workload identity pool and provider
3. restricts OIDC subjects to this repository, the `production` GitHub
   environment, and the `main` branch
4. applies the deployment roles used by the governed production workflow,
   including act-as authority only on the exact build and backend runtime
   service accounts, plus image-read authority only on the production backend
   artifact repository
5. writes the provider and service-account identifiers as GitHub `production`
   environment variables
6. runs the live deployment-environment governance verifier
7. reads the provider and project IAM policy back from GCP and compares them to
   the literals at the top of this script

Do not create a service-account key, reuse the Firebase Admin service account,
reuse UAT identity variables, or add a second production provider for this
repository. GitHub OIDC federation is the only deployment authentication path.

## Ownership boundary

- This script owns GCP deployment identity and the two GitHub environment
  variables consumed by the production workflow.
- `.github/workflows/deploy-production.yml` owns release sequencing, migration
  gates, candidate revisions, traffic promotion, health checks, and rollback.
- `config/ci-governance.json` owns required variable names and dispatch
  authority.
- GCP Secret Manager owns runtime credentials. This setup script never reads or
  writes application secrets.

## Verification

```bash
./scripts/ci/verify-production-environment-governance.sh
```

The verifier checks configuration names and environment governance without
printing variable values.

To compare this directory's record against what GCP actually has — the provider's
attribute mapping and condition, and every project role bound to the deploy service
account — run:

```bash
python3 scripts/ci/verify-deploy-identity-provenance.py
```

Its expectations are parsed from `setup_production_github_wif.sh` rather than
restated, so the script stays the single record. `--record-only` runs the half that
needs no cloud access (it is part of `repo-governance-check.sh`). A live read that
GCP refuses is reported as `deploy_identity_unverifiable` with a non-zero exit — it
is never recorded as a pass.

The grant record also covers the existing production release gates, rather than
exempting their bindings from the live comparison:

| Recorded role | Existing workflow consumer |
|---|---|
| `roles/cloudsql.client` | Cloud SQL Auth Proxy connections for migration, producer qualification and activation |
| `roles/cloudsql.viewer` | Backup/PITR posture and recent successful backup reads |
| `roles/logging.viewer` | Fresh Scheduler `AttemptFinished` evidence for cleanup activation |
| `projects/hushh-pda/roles/accountDeletionSchedulerOperator` | Cleanup and Drive Scheduler jobs get, list, create, update, run, pause and enable; locations list |
| `projects/hushh-pda/roles/predeployBackupOperator` | Optional predeploy backup runs create, get and list |

The two project custom roles are already provisioned in production. Their
observed permissions are limited respectively to
`cloudscheduler.jobs.{create,enable,get,list,pause,run,update}` plus
`cloudscheduler.locations.list`, and
`cloudsql.backupRuns.{create,get,list}`. Reconciliation records these existing
bindings; it does not require new live grants. The provider still accepts only
this repository's production environment on `main`, and the detector continues
to reject every undeclared project role, including privilege escalation.
See the [cleanup activation contract](../../docs/reference/operations/account-deletion-rollout.md#production-procedure)
and [backup posture contract](../../docs/reference/operations/production-db-backup-and-recovery.md).

The canonical setup now declares and reconciles the existing Scheduler role's
exact eight permissions and `GA` stage. The live verifier checks that definition
and its single unconditional binding to
`github-actions-prod-deployer@hushh-pda.iam.gserviceaccount.com`. Missing pause or
enable authority, extra permissions, another principal, a conditional binding,
or an inactive role fails verification. The Cloud Scheduler resume operation
requires `cloudscheduler.jobs.enable`; there is no `cloudscheduler.jobs.resume`
permission.

This is a project-level grant: these permissions cover Scheduler jobs throughout
`hushh-pda`, including jobs outside the three fixed Drive jobs used by the release
helper. The setup does not claim a job-level IAM condition or change WIF trust.
It reuses the existing role instead of creating another Scheduler operator.
Applying setup and observing a successful guarded release remain separate
evidence; `--record-only` performs no cloud reads or writes. Offline live-policy
rehearsals additionally supply `--scheduler-role-json` alongside the existing
provider, policy and prerequisite-role JSON inputs.

## Drive prerequisite reads

The fixed production Drive preflight also runs when a protected-document bucket
is configured with intake off, because the private maintenance worker still
needs provider and custody qualification. The canonical setup declares
`productionDrivePrerequisiteReader` with exactly:

- `apikeys.keys.list` for the reviewed Picker key's restrictions;
- `apikeys.keys.getKeyString` for its in-memory comparison with the existing
  Picker secret;
- `resourcemanager.projects.getIamPolicy` for the runtime's Scheduler-run grant.

These are project-level permissions. In particular, key-string read authority
covers API keys in the production project; it is not restricted to the Picker
key. The preflight reads only the fixed reviewed key, retains credential values
in memory and never prints them. The role grants no key creation, update,
deletion or IAM-policy mutation. Existing service-account reads are already
covered by the exact runtime and Scheduler account bindings and are not added.

Applying the reviewed canonical setup creates or updates this role and binds it
only to the existing production deployer. It does not create another identity,
change OIDC restrictions or grant UAT authority. The live identity verifier also
compares the role's name, permissions, declared launch stage and deleted state
with the declarations in that same setup script. Missing or extra permissions
fail verification. `--record-only` remains cloud-free. Setup completion and live
permission readback
are separate evidence from a successful run of the real production preflight.

## Production image promotion

For Dev to UAT, use the separate [UAT image promotion plan](#uat-image-promotion).

`deploy-production.yml` can deploy the exact backend image UAT verified for a
SHA instead of rebuilding it (`backend_image_source=promote-from-uat`). The
default stays `build-from-source` until these bindings exist and the founder
flips the default. The production frontend is always built in `hushh-pda`: its
image compiles production-only `NEXT_PUBLIC_*` values, so a UAT web image must
never serve production.

Exactly three bindings, all for
`serviceAccount:github-actions-prod-deployer@hushh-pda.iam.gserviceaccount.com`:

| Role | Resource | Why |
|---|---|---|
| `roles/artifactregistry.reader` | `projects/hushh-pda-uat/locations/us/repositories/gcr.io` | read the UAT-verified backend image |
| `roles/run.viewer` | project `hushh-pda-uat` | read the UAT backend revision's `deploy-sha` label and pinned image |
| `roles/artifactregistry.writer` | `projects/hushh-pda/locations/us/repositories/gcr.io` | copy that digest into the production registry |

```bash
bash deploy/iam/grant_production_image_promotion.sh          # prints the plan
bash deploy/iam/grant_production_image_promotion.sh --apply  # grants it
```

Nothing grants UAT write access or creates a key. If a binding is missing, the
promotion run stops with a message naming it: read access is checked before the
secret sync, backup gate, fence and migrations; write access fails at the copy,
still before the fence. Re-dispatch with `backend_image_source=build-from-source`
to ship without promotion.

## UAT image promotion

UAT's existing deployer is
`github-actions-uat-deployer@hushh-pda-uat.iam.gserviceaccount.com`, matching the
UAT environment's `GCP_DEPLOY_SERVICE_ACCOUNT` variable. Accepted Dev image
provenance travels in the existing exact-attempt acceptance receipt, so no Dev
Cloud Run read permission is needed.

| Role | Resource | Purpose |
|---|---|---|
| `roles/artifactregistry.reader` | `projects/hushh-pda-dev/locations/us/repositories/gcr.io` | read the accepted Dev image |
| `roles/artifactregistry.writer` | `projects/hushh-pda-uat/locations/us/repositories/gcr.io` | copy the digest into UAT, if effective write access is absent |

These standard roles cover every image in the named repository. Inspect
effective access, including inherited bindings, before adding roles: an absent
direct binding alone does not prove denial. No Dev write, secret, impersonation,
runtime identity or production access is granted.

`bash deploy/iam/grant_uat_image_promotion.sh` prints the fixed-resource plan
without cloud calls. Its `--apply` option adds only the Dev reader binding;
`--include-uat-writer` additionally selects the destination writer binding.
Each grant requires separate authorization after reviewing existing access. Remove the same
member/role from the same repository to revoke a newly added binding. Merge or
deployment approval alone does not authorize these grants.

The workflow stops on copy or permission failure before the migration fence.
An explicit `backend_image_source=build-from-source` retains the ordinary build
path while preserving exact-SHA Dev acceptance and all UAT release gates.

## Scheduled backup monitoring

`setup_production_backup_wif.sh` reuses this provider for the `production`
environment on `main`. It provisions a separate `github-prod-backup-reader`
identity with only `cloudsql.instances.get` and `cloudsql.backupRuns.list`, and
sets the environment variable `GCP_BACKUP_SERVICE_ACCOUNT`. It cannot connect
to the database, create/delete backups, deploy services or access runtime secrets.
Run `Verify Production Backups` after configuration and inspect its JSON report;
identity setup alone does not prove backup freshness or a successful restore drill.
