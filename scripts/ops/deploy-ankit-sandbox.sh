#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

die() { printf '%s\n' "$*" >&2; exit 1; }

# This Main-owned workflow uses the existing WIF submitter. Candidate code runs
# only with the dedicated build and runtime accounts.
project=hushh-pda-uat
region=us-central1
service=backend-dev-ankit
bucket=hushh-pda-uat-backend-dev-ankit-builds
image="$region-docker.pkg.dev/$project/$service/$service"
runtime="$service@$project.iam.gserviceaccount.com"
builder="$service-build@$project.iam.gserviceaccount.com"
sql="$project:$region:$service-pg"
baseline=e8c9b607229f87ba33cc3af838d880abdff8ec28

[[ ${SOURCE_SHA:-} =~ ^[0-9a-f]{40}$ ]] || die "Supply the full source commit SHA."
[[ ${SOURCE_SHA256:-} =~ ^[0-9a-f]{64}$ ]] || die "Supply the archive's SHA-256."
[[ ${SOURCE_OBJECT:-} =~ ^personal-backend/[a-zA-Z0-9._-]+#[1-9][0-9]{0,18}$ ]] ||
  die "Supply a generation-qualified object in the personal-backend prefix."
[[ ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ && ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]+$ ]] ||
  die "Expected a GitHub workflow run and attempt."

tag="iso-${SOURCE_SHA:0:12}"
revision="$service-$tag"
attempt="$SOURCE_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
flags=(--project="$project" --region="$region" --quiet)
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

gcloud storage cp "gs://$bucket/$SOURCE_OBJECT" "$stage/source.tar.gz" --project="$project" --quiet
printf '%s  %s\n' "$SOURCE_SHA256" "$stage/source.tar.gz" | sha256sum --check --status ||
  die "The selected source generation failed its SHA-256 check."

# Read the Git archive commit marker without extracting candidate files.
archive_sha="$(python3 -c '
import sys, tarfile
with tarfile.open(sys.argv[1], "r:gz") as archive:
    print(archive.pax_headers.get("comment", ""))
' "$stage/source.tar.gz")"
[[ "$archive_sha" == "$SOURCE_SHA" ]] || die "The archive does not record the selected Git commit."

require_private_policy() {
  gcloud run services get-iam-policy "$service" "${flags[@]}" --format=json |
    jq -e '[.bindings[]?.members[]?] | all(. != "allUsers" and . != "allAuthenticatedUsers")' >/dev/null ||
    die "The sandbox has a public IAM binding or its policy could not be verified."
}

existing="$(gcloud run services list "${flags[@]}" --filter="metadata.name=$service" --format='value(metadata.name)')"
deploy_flags=("${flags[@]}")
if [[ -n "$existing" ]]; then
  [[ "$existing" == "$service" ]] || die "Unexpected Cloud Run target."
  gcloud run services describe "$service" "${flags[@]}" --format=json |
    jq -e --arg owner ankit --arg tag "$tag" '
      .metadata.labels["sandbox-owner"] == $owner and
      .metadata.annotations["run.googleapis.com/invoker-iam-disabled"] != "true" and
      ([.spec.traffic[]?, .status.traffic[]?] | all(.tag != $tag))
    ' >/dev/null || die "The service is not a private sandbox or the commit tag already exists."
  require_private_policy
  deploy_flags+=(--no-traffic)
fi

# Keep the verified generation in the build config. Passing the URI as the
# source argument to builds submit stages a copy with a different generation.
{
  cat deploy/personal-backend-image.cloudbuild.yaml
  printf 'source:\n  storageSource:\n    bucket: "%s"\n    object: "%s"\n    generation: "%s"\n' \
    "$bucket" "${SOURCE_OBJECT%#*}" "${SOURCE_OBJECT##*#}"
} > "$stage/build.yaml"

build_id="$(gcloud builds submit --no-source --config="$stage/build.yaml" --project="$project" \
  --region=global --quiet --suppress-logs --format='value(id)' \
  --service-account="projects/$project/serviceAccounts/$builder" \
  --substitutions="_IMAGE=$image,_SOURCE_SHA=$SOURCE_SHA,_ATTEMPT=$attempt")"
[[ "$build_id" =~ ^[0-9a-f-]{36}$ ]] || die "Cloud Build did not return a build ID."
printf 'Cloud Build %s completed for %s\n' "$build_id" "$SOURCE_SHA"

gcloud builds describe "$build_id" --project="$project" --region=global --format=json |
  jq -e --arg bucket "$bucket" --arg object "${SOURCE_OBJECT%#*}" --arg generation "${SOURCE_OBJECT##*#}" '
    .status == "SUCCESS" and (.sourceProvenance.resolvedStorageSource |
      .bucket == $bucket and .object == $object and (.generation | tostring) == $generation)
  ' >/dev/null || die "Cloud Build did not confirm the selected source generation."

digest="$(gcloud artifacts docker images describe "$image:$attempt" --project="$project" \
  --format='value(image_summary.digest)')"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "The build did not publish an image digest."

env_vars="ENVIRONMENT=sandbox-ankit,GOOGLE_CLOUD_PROJECT=$project,APP_FRONTEND_ORIGIN=http://localhost:3000,CORS_ALLOWED_ORIGINS=http://localhost:3000"
env_vars+=",REQUIRE_DATABASE_ON_STARTUP=true,DB_NAME=backend_dev_ankit,DB_UNIX_SOCKET=/cloudsql/$sql"
env_vars+=",DB_POOL_MIN_SIZE=1,DB_POOL_MAX_SIZE=2,DB_SQLALCHEMY_POOL_SIZE=1,DB_SQLALCHEMY_MAX_OVERFLOW=0"
env_vars+=",OTEL_ENABLED=true,HUSHH_TELEMETRY_ENV=sandbox-ankit"
secrets="APP_SIGNING_KEY=BACKEND_DEV_ANKIT_APP_SIGNING_KEY:1,VAULT_DATA_KEY=BACKEND_DEV_ANKIT_VAULT_DATA_KEY:1"
secrets+=",DB_USER=BACKEND_DEV_ANKIT_DB_USER:1,DB_PASSWORD=BACKEND_DEV_ANKIT_DB_PASSWORD:1"

gcloud run deploy "$service" "${deploy_flags[@]}" \
  --service-account="$runtime" --ingress=all --invoker-iam-check --no-allow-unauthenticated \
  --set-cloudsql-instances="$sql" --min-instances=0 --max-instances=1 --concurrency=20 --timeout=3600 \
  --revision-suffix="$tag" --tag="$tag" --labels="sandbox-owner=ankit,deploy-sha=$SOURCE_SHA,env=sandbox-ankit" \
  --container=consent-protocol --image="$image@$digest" --port=8080 --cpu=2 --memory=4Gi \
  --set-env-vars="$env_vars" --set-secrets="$secrets" \
  --startup-probe='httpGet.path=/health,httpGet.port=8080,periodSeconds=5,failureThreshold=24'

gcloud run services add-iam-policy-binding "$service" "${flags[@]}" \
  --member=user:ankit@hushh.ai --role=roles/run.invoker --format=none

require_private_policy
gcloud run services describe "$service" "${flags[@]}" --format=json |
  jq -e --arg tag "$tag" --arg revision "$revision" '
    .metadata.annotations["run.googleapis.com/invoker-iam-disabled"] != "true" and
    ([.spec.traffic[], .status.traffic[]] | map(select(.tag == $tag)) |
      length == 2 and all(.revisionName == $revision and .latestRevision != true))
  ' >/dev/null || die "The private commit tag did not resolve to the new revision."
gcloud run revisions describe "$revision" "${flags[@]}" --format=json |
  jq -e --arg sha "$SOURCE_SHA" --arg digest "$digest" --arg runtime "$runtime" --arg sql "$sql" '
    .metadata.labels["deploy-sha"] == $sha and .metadata.labels.env == "sandbox-ankit" and
    .metadata.annotations["run.googleapis.com/cloudsql-instances"] == $sql and
    .spec.serviceAccountName == $runtime and
    (.status.imageDigest | split("@")[-1]) == $digest and
    any(.status.conditions[]; .type == "Ready" and .status == "True")
  ' >/dev/null || die "The revision did not match the sandbox deployment."

printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$SOURCE_SHA" "$project" "$region" "$service" "$baseline" "$digest" \
  > "${RUNNER_TEMP:?Expected the GitHub runner temporary directory}/hushh-personal-backend"
printf 'Cloud Build: %s\nRevision: %s\nCommit: %s\nImage: %s@%s\n' \
  "$build_id" "$revision" "$SOURCE_SHA" "$image" "$digest" | tee -a "${GITHUB_STEP_SUMMARY:?}"
