# Production DB Backup and Recovery (Cloud SQL)


## Visual Context

Canonical visual owner: [Operations Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This runbook defines production recovery readiness using native Cloud SQL
automated backups plus point-in-time recovery (PITR).

Scope:
- Production runs on Cloud SQL for PostgreSQL 15
  (`hushh-pda:us-central1:hushh-vault-db`, database `hushh_vault`).
- Backups are managed by Cloud SQL itself: a daily automated backup plus
  continuous write-ahead-log archiving for PITR.
- No application-side dump job, GCS backup bucket, or logical-backup Cloud Run
  job is involved in the production recovery path.

---

## Recovery Profile

- Effective RPO target: `<= 5 minutes` (PITR via transaction logs)
- RTO target: `<= 2 hours` (validated by monthly restore drill)
- Automated backup retention: `30` most recent backups
- Transaction log retention: `7` days

---

## Enforced Controls

1. Cloud SQL automated backups + PITR on the production instance:
- daily automated backup window
- `pointInTimeRecoveryEnabled = true` with 7-day transaction log retention
- on-demand backups may be taken at any time before risky operations

2. Pre-deploy backup posture gate in the production deployment workflow:
- runs `scripts/ops/cloudsql_backup_freshness_check.py`
- blocks deploy when backups or PITR are disabled, or when the most recent
  successful backup is older than `BACKUP_MAX_AGE_HOURS`
- optional on-demand backup before the gate via workflow input
  `run_predeploy_backup_job=true`

3. Migration governance gate before production backend deploy:
- enforces monotonic numbered migration files in `consent-protocol/db/migrations`
- enforces the production contract in `consent-protocol/db/contracts/prod_core_schema.json`
- runs read-only live schema drift checks for production-critical tables/columns

4. Release evidence artifact:
- generates `prod_migration_release_manifest.json`
- records git SHA, operator, migration files/hash, and backup evidence

5. Daily posture workflow:
- `.github/workflows/prod-cloudsql-backup-posture.yml`
- validates backup/PITR posture and uploads a JSON report artifact

---

## Runtime Config

The production instance owns its own backup configuration; there is no
provisioning script to run. To (re-)apply the posture:

```bash
gcloud sql instances patch hushh-vault-db \
  --project hushh-pda \
  --backup-start-time=06:00 \
  --enable-point-in-time-recovery \
  --retained-backups-count=30 \
  --retained-transaction-log-days=7
```

Required DB access for the application (Cloud Run):
- Cloud SQL instance attached via `--add-cloudsql-instances`
- `DB_HOST=cloudsql-socket`, `DB_UNIX_SOCKET=/cloudsql/<instance connection name>`
- `DB_USER`, `DB_PASSWORD` (Secret Manager)

---

## Local Verification Commands

Check backup + PITR posture (read-only):

```bash
python3 scripts/ops/cloudsql_backup_freshness_check.py \
  --project-id hushh-pda \
  --instance hushh-vault-db \
  --max-age-hours 30 \
  --report-path /tmp/prod-backup-posture-report.json
```

List recent backups:

```bash
gcloud sql backups list --instance hushh-vault-db --project hushh-pda --limit 10
```

Take an on-demand backup before a risky operation:

```bash
gcloud sql backups create \
  --instance hushh-vault-db \
  --project hushh-pda \
  --description "pre-change-snapshot"
```

Migration guard (read-only):

```bash
./bin/hushh db report-prod-posture
```

UAT uses a different contract because it is the latest integration lane:

```bash
./bin/hushh db verify-uat-schema
```

Local contract alignment check:

```bash
./bin/hushh db verify-release-contract
```

Generate release manifest:

```bash
python3 scripts/ops/generate_migration_release_manifest.py \
  --output /tmp/prod-migration-release-manifest.json \
  --environment production \
  --backup-report-path /tmp/backup-posture-report.json
```

---

## Recovery Procedures

Restore to a point in time (creates a NEW instance; never overwrites in place):

```bash
gcloud sql instances clone hushh-vault-db hushh-vault-db-pitr-restore \
  --project hushh-pda \
  --point-in-time "2026-07-28T00:00:00.000Z"
```

Restore a specific automated/on-demand backup into a recovery instance:

```bash
gcloud sql backups restore <BACKUP_ID> \
  --restore-instance=hushh-vault-db-recovery \
  --backup-instance=hushh-vault-db \
  --project hushh-pda
```

Validate the recovered instance before repointing traffic, then update
`DB_UNIX_SOCKET` / the attached Cloud SQL instance for the backend service.

---

## Restore Drill Cadence

Weekly integrity verification:
- confirm automated backups and PITR are still enabled
- confirm the most recent automated backup succeeded and is within threshold

Monthly restore drill:
1. Clone the production instance to an isolated PITR target (never in place).
2. Run sanity checks:
- key table counts (`consent_audit`, `vault_keys`, `pkm_index`, `pkm_blobs`, `kai_market_cache_entries`, `tickers`)
- coherence checks (PKM blob/index integrity)
3. Record:
- drill start/end time
- observed restore duration (RTO)
- pass/fail and remediation actions
4. Delete the drill instance when complete.
