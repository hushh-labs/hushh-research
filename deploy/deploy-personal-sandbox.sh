#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

die() { printf '%s\n' "$*" >&2; exit 1; }

# This Main-owned workflow uses the existing WIF submitter. Candidate code runs
# only with the dedicated build and runtime accounts.
project=hushh-pda-uat
region=us-central1
owner="${SANDBOX:-ankit}"
approved_sha=
approved_tar=
python3 scripts/ci/assert-governed-actor.py --surface uat --actor "${GITHUB_ACTOR:?}"
case "$owner" in
  ankit)
    invoker=ankit@hushh.ai
    auth_project=hushh-team-sandbox-auth
    adc_project=$project
    baseline=e8c9b607229f87ba33cc3af838d880abdff8ec28
    ;;
  akshat)
    invoker=i-akshat@hush1one.com
    auth_project=hushh-akshat-sandbox-auth
    adc_project=$auth_project
    baseline=d884959b5b1dc666b01998b24bdd8138be93161e
    approved_sha=5f4dcb772a66a303fb925f267246bc2e17b0ba9f
    # Hash the Git tar before compression so gzip implementation is immaterial.
    approved_tar=8ca26e5c906f28acce2ce6e3c5caeacb60853d9c059da15c190939225d5184c5
    ;;
  *) die "Unknown sandbox; no resources selected." ;;
esac
service="backend-dev-$owner"
bucket="$project-$service-builds"
image="$region-docker.pkg.dev/$project/$service/$service"
runtime="$service@$project.iam.gserviceaccount.com"
builder="$service-build@$project.iam.gserviceaccount.com"
sql="$project:$region:$service-pg"
database="backend_dev_$owner"
secret_prefix="BACKEND_DEV_$(printf '%s' "$owner" | tr '[:lower:]' '[:upper:]')"

[[ ${SOURCE_SHA:-} =~ ^[0-9a-f]{40}$ ]] || die "Supply the full source commit SHA."
source_mode=legacy
azure_client=
if [[ "$owner" == akshat && "$SOURCE_SHA" != "$approved_sha" ]]; then
  [[ -z "${SOURCE_OBJECT:-}${SOURCE_SHA256:-}${REUSE_BUILD_ID:-}" ]] ||
    die "Supply only the SHA for a new Akshat source; Main prepares the qualified archive."
  source_mode=qualified
  azure_client=afd2feb2-fd0f-422c-bdfe-0b7c7e14b5ed
fi
if [[ "$owner" == akshat && -n "${REUSE_BUILD_ID:-}" ]]; then
  die "Akshat recovery uses the build ID recorded on the ready revision."
fi
if [[ "${1:-}" == --authorize && $# == 1 ]]; then
  printf '%s\n' "$source_mode"
  exit 0
fi
[[ $# == 0 ]] || die "Unexpected arguments."
[[ ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ && ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]+$ ]] ||
  die "Expected a GitHub workflow run and attempt."

tag="iso-${SOURCE_SHA:0:12}"
suffix="$tag-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
if [[ "$source_mode" == qualified ]]; then
  local_source="${RUNNER_TEMP:?Expected the runner temporary directory}/hushh-sandbox-qualified-source.tar.gz"
  [[ -s "$local_source" && -f "$local_source" && ! -L "$local_source" ]] ||
    die "The trusted qualification step did not prepare a source archive."
  # Bind the revision tag to the deploy recipe, as well as the exact application SHA.
  config_hash="$(sha256sum deploy/deploy-personal-sandbox.sh deploy/personal-backend-image.cloudbuild.yaml | sha256sum)"
  tag+="-${config_hash:0:8}-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
  suffix="$tag"
  SOURCE_SHA256="$(sha256sum "$local_source")"
  SOURCE_SHA256="${SOURCE_SHA256%% *}"
  SOURCE_OBJECT="personal-backend/$SOURCE_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.tar.gz"
  source_url="gs://$bucket/$SOURCE_OBJECT"
  gcloud storage cp "$local_source" "$source_url" --if-generation-match=0 --project="$project" --quiet
  generation="$(gcloud storage objects describe "$source_url" --project="$project" --format='value(generation)')"
  SOURCE_OBJECT+="#$generation"
  approved_tar=
fi
[[ ${SOURCE_SHA256:-} =~ ^[0-9a-f]{64}$ ]] || die "Supply the archive's SHA-256."
[[ ${SOURCE_OBJECT:-} =~ ^personal-backend/[a-zA-Z0-9._-]+#[1-9][0-9]{0,18}$ ]] ||
  die "Supply a generation-qualified object in the personal-backend prefix."
revision="$service-$suffix"
attempt="$SOURCE_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
flags=(--project="$project" --region="$region" --quiet)
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

gcloud storage cp "gs://$bucket/$SOURCE_OBJECT" "$stage/source.tar.gz" --project="$project" --quiet
archive_hash="$(sha256sum "$stage/source.tar.gz")"
[[ "${archive_hash%% *}" == "$SOURCE_SHA256" ]] ||
  die "The selected source generation failed its SHA-256 check."

if [[ -n "$approved_tar" ]]; then
  tar_hash="$(gzip -dc "$stage/source.tar.gz" | sha256sum)"
  [[ "${tar_hash%% *}" == "$approved_tar" ]] || die "Archive contents differ from the approved Git tar."
fi

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
reuse_revision=false
build_id="${REUSE_BUILD_ID:-}"
pin_traffic=true
if [[ -n "$existing" ]]; then
  [[ "$existing" == "$service" ]] || die "Unexpected Cloud Run target."
  service_state="$(gcloud run services describe "$service" "${flags[@]}" \
    --format='json(metadata.labels,metadata.annotations,spec.traffic,status.traffic,status.latestReadyRevisionName)')"
  jq -e --arg owner "$owner" '
    .metadata.labels["sandbox-owner"] == $owner and
    .metadata.annotations["run.googleapis.com/invoker-iam-disabled"] != "true"
  ' <<< "$service_state" >/dev/null || die "The target is not a private sandbox."
  require_private_policy
  if [[ -n "$(jq -r '.status.latestReadyRevisionName // ""' <<< "$service_state")" ]]; then
    deploy_flags+=(--no-traffic)
    pin_traffic=false
  fi

  previous_revision="$(jq -r --arg tag "$tag" '.spec.traffic[]? | select(.tag == $tag) | .revisionName' <<< "$service_state")"
  if [[ -n "$previous_revision" ]]; then
    [[ "$previous_revision" =~ ^$service-[a-z0-9-]+$ ]] || die "Unexpected tagged revision."
    previous="$(gcloud run revisions describe "$previous_revision" "${flags[@]}" \
      --format='json(metadata.labels,status.conditions)')"
    ready="$(jq -er '.status.conditions[] | select(.type == "Ready") | .status' <<< "$previous")"
    case "$ready" in
      True)
        if [[ "$owner" == akshat ]]; then
          build_id="$(jq -er '.metadata.labels["sandbox-build-id"]' <<< "$previous")" ||
            die "The ready revision lacks its verified build ID."
        fi
        [[ -n "$build_id" ]] || die "Supply the verified build ID to finalize a ready revision."
        jq -e --arg tag "$tag" --arg revision "$previous_revision" '
          ([.status.traffic[]? | select(.tag == $tag)] |
            length == 1 and .[0].revisionName == $revision)
        ' <<< "$service_state" >/dev/null || die "The serving tag does not match its explicit revision."
        reuse_revision=true
        revision="$previous_revision"
        # The first ready revision can have its tag and default traffic merged
        # in status. Freeze that default without moving the tag or rebuilding.
        if jq -e --arg tag "$tag" --arg revision "$revision" '
          .status.latestReadyRevisionName == $revision and
          any(.status.traffic[]?; .tag == $tag and .latestRevision == true and .percent == 100)
        ' <<< "$service_state" >/dev/null; then
          pin_traffic=true
        fi
        ;;
      False) ;;
      *) die "The tagged revision is still settling." ;;
    esac
  fi
fi

if [[ -z "$build_id" ]]; then
  # Preserve the verified generation. A source argument to builds submit would
  # stage a copy with a different generation.
  {
    cat deploy/personal-backend-image.cloudbuild.yaml
    printf 'source:\n  storageSource:\n    bucket: "%s"\n    object: "%s"\n    generation: "%s"\n' \
      "$bucket" "${SOURCE_OBJECT%#*}" "${SOURCE_OBJECT##*#}"
  } > "$stage/build.yaml"

  build_id="$(gcloud builds submit --no-source --config="$stage/build.yaml" --project="$project" \
    --region=global --quiet --suppress-logs --format='value(id)' \
    --service-account="projects/$project/serviceAccounts/$builder" \
    --substitutions="_IMAGE=$image,_SOURCE_SHA=$SOURCE_SHA,_ATTEMPT=$attempt,_SANDBOX=$owner")"
fi
[[ "$build_id" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] || die "Expected a Cloud Build ID."

build="$(gcloud builds describe "$build_id" --project="$project" --region=global --format=json)"
attempt="$(jq -er --arg bucket "$bucket" --arg object "${SOURCE_OBJECT%#*}" --arg generation "${SOURCE_OBJECT##*#}" \
    --arg builder "projects/$project/serviceAccounts/$builder" --arg image "$image" --arg sha "$SOURCE_SHA" '
      select(.status == "SUCCESS" and .serviceAccount == $builder
        and .substitutions._IMAGE == $image and .substitutions._SOURCE_SHA == $sha
        and (.sourceProvenance.resolvedStorageSource |
          .bucket == $bucket and .object == $object and (.generation | tostring) == $generation))
      | .substitutions._ATTEMPT
    ' <<< "$build")" || die "Cloud Build did not confirm the exact sandbox builder, image and source."
[[ "$attempt" =~ ^$SOURCE_SHA-[0-9]+-[0-9]+$ ]] || die "Unexpected sandbox image attempt tag."
printf 'Verified Cloud Build %s for %s\n' "$build_id" "$SOURCE_SHA"

if [[ "$owner" == akshat ]]; then
  digest="$(jq -er --arg image "$image:$attempt" '
    .results.buildStepOutputs[1] | select(type == "string" and length <= 4096)
    | @base64d | fromjson | select(.image == $image) | .digest
  ' <<< "$build")" || die "Cloud Build did not record a digest for the exact sandbox image."
else
  digest="$(gcloud artifacts docker images describe "$image:$attempt" --project="$project" \
    --format='value(image_summary.digest)')"
fi
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "The build did not publish an image digest."

if [[ "$reuse_revision" == false ]]; then
  # The backend uses a recognized runtime profile. Telemetry has its own label.
  env_vars="ENVIRONMENT=development,GOOGLE_CLOUD_PROJECT=$adc_project,APP_FRONTEND_ORIGIN=http://localhost:3000,CORS_ALLOWED_ORIGINS=http://localhost:3000"
  env_vars+=",REQUIRE_DATABASE_ON_STARTUP=true,DB_NAME=$database,DB_UNIX_SOCKET=/cloudsql/$sql"
  # Each worker holds three LISTEN connections. Preserve one request slot.
  env_vars+=",DB_POOL_MIN_SIZE=1,DB_POOL_MAX_SIZE=4,DB_SQLALCHEMY_POOL_SIZE=1,DB_SQLALCHEMY_MAX_OVERFLOW=0"
  env_vars+=",OTEL_ENABLED=true,HUSHH_TELEMETRY_ENV=sandbox-$owner"
  if [[ "$owner" == ankit ]]; then
    env_vars+=",HUSHH_SANDBOX_FIREBASE_PROJECT_ID=$auth_project"
    env_vars+=",ONE_VOICE_LIVE_ENABLED=true"
  else
    # The approved source resolves Firebase's issuer through Google ADC.
    env_vars+=",WEB_CONCURRENCY=1,OTEL_EXPORTER_GCP_TRACE_PROJECT_ID=$project"
    if [[ -n "$azure_client" ]]; then
      env_vars+=",HUSHH_SANDBOX_MANAGED_AI_PROVIDER=azure_openai,HUSHH_SANDBOX_AZURE_CLIENT_ID=$azure_client"
    fi
  fi
  env_vars+=',OTEL_EXPORTER_GCP_TRACE_RESOURCE_REGEX=^(deployment[.]environment|service[.]name)$'
  secrets="APP_SIGNING_KEY=${secret_prefix}_APP_SIGNING_KEY:1,VAULT_DATA_KEY=${secret_prefix}_VAULT_DATA_KEY:1"
  secrets+=",DB_USER=${secret_prefix}_DB_USER:1,DB_PASSWORD=${secret_prefix}_DB_PASSWORD:1"

  labels="sandbox-owner=$owner,deploy-sha=$SOURCE_SHA,env=sandbox-$owner"
  if [[ "$owner" == akshat ]]; then
    labels+=",sandbox-build-id=$build_id"
  fi
  gcloud run deploy "$service" "${deploy_flags[@]}" \
    --service-account="$runtime" --ingress=all --invoker-iam-check --no-allow-unauthenticated \
    --set-cloudsql-instances="$sql" --min-instances=0 --max-instances=1 --concurrency=20 --timeout=3600 \
    --revision-suffix="$suffix" --tag="$tag" --labels="$labels" \
    --container=consent-protocol --image="$image@$digest" --port=8080 --cpu=2 --memory=4Gi \
    --set-env-vars="$env_vars" --set-secrets="$secrets" \
    --startup-probe='httpGet.path=/health,httpGet.port=8080,periodSeconds=5,failureThreshold=24'
fi

gcloud run revisions describe "$revision" "${flags[@]}" --format=json |
  jq -e --arg sha "$SOURCE_SHA" --arg digest "$digest" --arg runtime "$runtime" \
    --arg sql "$sql" --arg owner "$owner" --arg auth "$auth_project" --arg build "$build_id" --arg client "$azure_client" '
    .metadata.labels["deploy-sha"] == $sha and .metadata.labels.env == ("sandbox-" + $owner) and
    ($owner == "ankit" or
      (.metadata.labels["sandbox-build-id"] == $build and
       any(.spec.containers[].env[]; .name == "GOOGLE_CLOUD_PROJECT" and .value == $auth))) and
    ($client == "" or
      (any(.spec.containers[].env[]; .name == "HUSHH_SANDBOX_MANAGED_AI_PROVIDER" and .value == "azure_openai") and
       any(.spec.containers[].env[]; .name == "HUSHH_SANDBOX_AZURE_CLIENT_ID" and .value == $client))) and
    .metadata.annotations["run.googleapis.com/cloudsql-instances"] == $sql and
    .spec.serviceAccountName == $runtime and
    (.status.imageDigest | split("@")[-1]) == $digest and
    any(.status.conditions[]; .type == "Ready" and .status == "True")
  ' >/dev/null || die "The revision did not match the sandbox deployment."

if [[ "$pin_traffic" == true ]]; then
  gcloud run services update-traffic "$service" "${flags[@]}" --to-revisions="$revision=100"
fi
gcloud run services add-iam-policy-binding "$service" "${flags[@]}" \
  --member="user:$invoker" --role=roles/run.invoker --format=none
if [[ "$owner" == akshat ]]; then
  gcloud run services add-iam-policy-binding "$service" "${flags[@]}" \
    --member="user:$invoker" --role=roles/run.viewer --format=none
fi

require_private_policy
gcloud run services describe "$service" "${flags[@]}" --format=json |
  jq -e --arg tag "$tag" --arg revision "$revision" '
    .metadata.annotations["run.googleapis.com/invoker-iam-disabled"] != "true" and
    ([.spec.traffic[], .status.traffic[]] | map(select(.tag == $tag)) |
      length == 2 and all(.revisionName == $revision and .latestRevision != true))
  ' >/dev/null || die "The private commit tag did not resolve to the new revision."
receipt="${RUNNER_TEMP:?Expected the GitHub runner temporary directory}/hushh-personal-backend"
if [[ -n "$azure_client" ]]; then
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$SOURCE_SHA" "$project" "$region" "$service" "$baseline" "$digest" "$tag" "$azure_client" > "$receipt"
else
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$SOURCE_SHA" "$project" "$region" "$service" "$baseline" "$digest" > "$receipt"
fi
printf 'Cloud Build: %s\nRevision: %s\nCommit: %s\nImage: %s@%s\n' \
  "$build_id" "$revision" "$SOURCE_SHA" "$image" "$digest" | tee -a "${GITHUB_STEP_SUMMARY:?}"
