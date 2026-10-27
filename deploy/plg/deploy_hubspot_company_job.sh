#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
set -euo pipefail

# Called only after the production release's image, schema and health gates.
readonly project=hushh-pda region=us-central1 job=one-hubspot-company-sync
readonly runtime="one-hubspot-sync@${project}.iam.gserviceaccount.com"
readonly scheduler="one-hubspot-sync-sched@${project}.iam.gserviceaccount.com"
readonly schedule=one-hubspot-company-sync-every-minute
: "${DEPLOY_SHA:?qualified source required}"
if [[ ! "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Company CRM release identity is invalid' >&2; exit 1
fi
exists="$(gcloud run jobs list --project="$project" --region="$region" --format='value(metadata.name)' --filter="metadata.name=$job")"
case "${ENABLE_COMPANY_CRM_SYNC:-false}" in true|false) ;; *) exit 1 ;; esac
if [[ -z "$exists" && "${ENABLE_COMPANY_CRM_SYNC:-false}" != true ]]; then
  echo 'Company CRM sync has not been activated'; exit 0
fi
# Rollbacks must keep the cleanup-capable job instead of replacing it with an
# older API image that has no CRM entrypoint. Never drop outstanding receipts.
if ! git cat-file -e "${DEPLOY_SHA}:consent-protocol/scripts/hubspot_company_sync.py"; then
  echo 'Preserving existing CRM cleanup worker across pre-feature rollback'; exit 0
fi
if [[ -z "${IMAGE_REFERENCE:-}" ]]; then
  # Continuation lanes already qualified traffic. Read the sole serving
  # revision rather than latest-ready (which may be an unserved candidate).
  serving="$(gcloud run services describe consent-protocol --project="$project" --region="$region" --format=json \
    | python3 -c 'import json,sys; t=json.load(sys.stdin)["status"]["traffic"]; r=[x["revisionName"] for x in t if x.get("percent")==100]; assert len(r)==1; print(r[0])')"
  IMAGE_REFERENCE="$(gcloud run revisions describe "$serving" --project="$project" --region="$region" --format=json \
    | EXPECTED_SHA="$DEPLOY_SHA" python3 -c 'import json,os,sys; r=json.load(sys.stdin); assert r["metadata"]["labels"]["deploy-sha"]==os.environ["EXPECTED_SHA"]; print(r["status"]["imageDigest"])')"
fi
if [[ ! "$IMAGE_REFERENCE" =~ ^gcr\.io/hushh-pda/consent-protocol@sha256:[0-9a-f]{64}$ ]]; then
  echo 'Company CRM image is not an immutable production backend image' >&2; exit 1
fi
# Credential payloads never cross this setup port: copy exact local secret refs.
secret_bindings="$(gcloud run services describe consent-protocol --project="$project" --region="$region" --format=json \
  | python3 -c 'import json,re,sys; c=json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0]; env={e["name"]:e for e in c["env"]}; refs=[]
for name in ("BACKEND_RUNTIME_CONFIG_JSON","DB_USER","DB_PASSWORD"):
 r=env[name]["valueFrom"]["secretKeyRef"]; assert re.fullmatch("[A-Z0-9_]+",r["name"]) and re.fullmatch("[a-zA-Z0-9]+",r["key"]); refs.append(name+"="+r["name"]+":"+r["key"])
print(",".join(refs))')"
for identity in "$runtime" "$scheduler"; do
  gcloud iam service-accounts describe "$identity" --project="$project" --format='value(email)' >/dev/null
done
# IAM is pre-provisioned by an authorized operator: exact-secret accessor,
# Firebase read-only, Cloud SQL client, and release actAs on these two accounts.
# The release identity must never acquire project IAM administration.
gcloud run jobs deploy "$job" --project="$project" --region="$region" \
  --image="$IMAGE_REFERENCE" --service-account="$runtime" \
  --tasks=1 --parallelism=1 --max-retries=0 --task-timeout=300s --cpu=1 --memory=1Gi \
  --set-cloudsql-instances=hushh-pda:us-central1:hushh-vault-db \
  --set-env-vars="ENVIRONMENT=production,GOOGLE_CLOUD_PROJECT=hushh-pda,ONE_HUBSPOT_SYNC_ENABLED=true,HUBSPOT_COMPANY_PORTAL_ID=247569195,DB_SQLALCHEMY_USE_NULL_POOL=true" \
  --set-secrets="${secret_bindings},HUBSPOT_COMPANY_SYNC_SERVICE_KEY=HUBSPOT_COMPANY_SYNC_SERVICE_KEY:latest" \
  --labels="deploy-sha=${DEPLOY_SHA},managed-by=production-release" \
  --command=python --args=scripts/hubspot_company_sync.py --quiet >/dev/null
gcloud run jobs add-iam-policy-binding "$job" --project="$project" --region="$region" \
  --member="serviceAccount:$scheduler" --role=roles/run.invoker --quiet >/dev/null
# Prove startup and portal/schema access before creating a recurring trigger.
gcloud run jobs execute "$job" --project="$project" --region="$region" --wait --quiet
schedule_exists="$(gcloud scheduler jobs list --project="$project" --location="$region" --filter="name:$schedule" --format='value(name)')"
operation=create
if [[ -n "$schedule_exists" ]]; then operation=update; fi
gcloud scheduler jobs "$operation" http "$schedule" --project="$project" --location="$region" \
  --schedule='* * * * *' --time-zone=Etc/UTC --http-method=POST \
  --uri="https://run.googleapis.com/v2/projects/$project/locations/$region/jobs/$job:run" \
  --oauth-service-account-email="$scheduler" --oauth-token-scope=https://www.googleapis.com/auth/cloud-platform \
  --message-body='{}' --max-retry-attempts=0 --quiet >/dev/null
echo 'Company CRM worker deployed; one-minute schedule configured; application lock prevents overlap.'
