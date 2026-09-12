#!/usr/bin/env bash
set -euo pipefail

# Publish immutable model artifacts and atomically rotate a registry that holds
# object identity only. The backend reads the latest registry through Secret
# Manager and creates a fresh short-lived URL per capability request.
environment="${1:?usage: publish-one-voice-model-packs.sh ENVIRONMENT BUCKET [REGISTRY_SECRET] [OBJECT_PREFIX] [ARTIFACT_DIR] [SOURCE_SHA]}"
bucket="${2:?usage: publish-one-voice-model-packs.sh ENVIRONMENT BUCKET [REGISTRY_SECRET] [OBJECT_PREFIX] [ARTIFACT_DIR] [SOURCE_SHA]}"
registry_secret="${3:-HUSHH_LOCAL_RUNTIME_PACK_REGISTRY}"
object_prefix="${4:-one-voice/model-packs}"
artifact_dir="${5:-${RUNNER_TEMP:-/tmp}/one-voice-model-packs}"
source_sha="${6:-${GITHUB_SHA:-}}"

case "$environment" in
  uat)
    project="hushh-pda-uat"
    expected_bucket="hushh-pda-uat-one-voice-model-packs"
    ;;
  production)
    project="hushh-pda"
    expected_bucket="hushh-pda-one-voice-model-packs"
    ;;
  *)
    echo "Environment must be uat or production." >&2
    exit 1
    ;;
esac

if [[ "$bucket" != "$expected_bucket" ]]; then
  echo "Refusing a cross-environment or unapproved model bucket." >&2
  exit 1
fi
if [[ ! "$registry_secret" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "Registry secret name contains unsupported characters." >&2
  exit 1
fi
if [[ ! "$object_prefix" =~ ^[A-Za-z0-9._/-]+$ ]] || [[ "$object_prefix" == /* ]]; then
  echo "Object prefix must be a normalized path." >&2
  exit 1
fi
if [[ ! "$source_sha" =~ ^[0-9a-fA-F]{7,64}$ ]]; then
  echo "Model packs must be tied to an exact merged source SHA." >&2
  exit 1
fi

asr_file="$artifact_dir/one-voice-en-asr-sherpa-onnx-v1.data"
ranker_file="$artifact_dir/one-voice-en-intent-minilm-v1.pack.zip"
[[ -s "$asr_file" && -s "$ranker_file" ]] || {
  echo "Expected verified model artifacts in $artifact_dir." >&2
  exit 1
}
python3 "$(dirname "$0")/verify-one-voice-model-pack.py" "$ranker_file" >/dev/null

# The NVIDIA-licensed streaming model is never downloaded or enabled by
# default. A protected release workflow may provide a reviewed source archive
# and explicit version after legal approval. Package and verify it here so the
# registry can never advertise a raw upstream snapshot or an unreviewed model.
fluid_source_archive="${FLUID_AUDIO_SOURCE_ARCHIVE:-}"
fluid_version="${FLUID_AUDIO_VERSION:-}"
fluid_file=""
if [[ -n "$fluid_source_archive" || -n "$fluid_version" ]]; then
  if [[ -z "$fluid_source_archive" || -z "$fluid_version" || ! -s "$fluid_source_archive" ]]; then
    echo "FluidAudio publication requires a non-empty approved source archive and version." >&2
    exit 1
  fi
  fluid_file="$artifact_dir/fluid-audio-parakeet-eou-120m-coreml-v1.pack.zip"
  python3 "$(dirname "$0")/package-fluid-audio-model-pack.py" \
    --source-archive "$fluid_source_archive" \
    --notices "hushh-webapp/ios/App/App/OneVoiceModelNotices.json" \
    --version "$fluid_version" \
    --output "$fluid_file" >/dev/null
  python3 "$(dirname "$0")/verify-fluid-audio-model-pack.py" \
    "$fluid_file" \
    --notices "hushh-webapp/ios/App/App/OneVoiceModelNotices.json" \
    --version "$fluid_version" >/dev/null
fi

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

ranker_version="$(python3 - "$ranker_file" <<'PY'
import json
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    manifest = json.loads(archive.read("manifest.json"))
if (
    manifest.get("pack_id") != "one-voice-en-intent-minilm-v1"
    or not isinstance(manifest.get("version"), str)
    or not manifest["version"].strip()
):
    raise SystemExit("verified ranker pack has an invalid identity")
print(manifest["version"].strip())
PY
)"
asr_version="1.13.7"
source_sha="$(printf '%s' "$source_sha" | tr '[:upper:]' '[:lower:]')"
asr_object="$object_prefix/$source_sha/one-voice-en-asr-sherpa-onnx-v1/$asr_version.data"
ranker_object="$object_prefix/$source_sha/one-voice-en-intent-minilm-v1/$ranker_version.pack.zip"
fluid_object=""
if [[ -n "$fluid_file" ]]; then
  fluid_object="$object_prefix/$source_sha/fluid-audio-parakeet-eou-120m-coreml-v1/$fluid_version.pack.zip"
fi

gcloud storage buckets describe "gs://$bucket" --project="$project" >/dev/null

upload_immutable() {
  local file="$1"
  local object="$2"
  local digest="$3"
  local content_type="$4"
  local existing_digest
  existing_digest="$(gcloud storage objects describe "gs://$bucket/$object" --project="$project" \
    --format='value(metadata.sha256)' 2>/dev/null || true)"
  if [[ -n "$existing_digest" ]]; then
    if [[ "$existing_digest" != "$digest" ]]; then
      echo "Immutable model object exists with a different checksum." >&2
      exit 1
    fi
    return
  fi
  gcloud storage cp \
    --project="$project" \
    --if-generation-match=0 \
    --cache-control="public,max-age=300,must-revalidate" \
    --content-type="$content_type" \
    --custom-metadata="sha256=$digest,source_sha=$source_sha" \
    "$file" "gs://$bucket/$object"
}

asr_sha256="$(sha256_file "$asr_file")"
ranker_sha256="$(sha256_file "$ranker_file")"
upload_immutable "$asr_file" "$asr_object" "$asr_sha256" "application/octet-stream"
upload_immutable "$ranker_file" "$ranker_object" "$ranker_sha256" "application/zip"
fluid_sha256=""
fluid_bytes=""
if [[ -n "$fluid_file" ]]; then
  fluid_sha256="$(sha256_file "$fluid_file")"
  fluid_bytes="$(wc -c < "$fluid_file" | tr -d ' ')"
  upload_immutable "$fluid_file" "$fluid_object" "$fluid_sha256" "application/zip"
fi

if ! gcloud secrets describe "$registry_secret" --project="$project" >/dev/null 2>&1; then
  gcloud secrets create "$registry_secret" --replication-policy=automatic --project="$project" >/dev/null
fi

work_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/one-voice-registry.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
previous_registry="$work_dir/previous.json"
registry="$work_dir/registry.json"
gcloud secrets versions access latest "$registry_secret" --project="$project" \
  --out-file="$previous_registry" >/dev/null 2>&1 || : > "$previous_registry"

registry_args=(
  --output "$registry" \
  --bucket "$bucket" \
  --source-sha "$source_sha" \
  --object-prefix "$object_prefix" \
  --asr-file "$asr_file" \
  --asr-version "$asr_version" \
  --asr-object "$asr_object" \
  --ranker-file "$ranker_file" \
  --ranker-object "$ranker_object" \
  --previous-registry "$previous_registry"
)
if [[ -n "$fluid_file" ]]; then
  registry_args+=(
    --fluid-audio-file "$fluid_file" \
    --fluid-audio-version "$fluid_version" \
    --fluid-audio-object "$fluid_object"
  )
fi
python3 "$(dirname "$0")/build-one-voice-model-pack-registry.py" "${registry_args[@]}" >/dev/null

# Adding a Secret Manager version is atomic. Cloud Run reads latest at bounded
# intervals, so rollout and rollback never depend on stale signed URLs or a
# service redeploy.
gcloud secrets versions add "$registry_secret" --data-file="$registry" --project="$project" >/dev/null

python3 - "$environment" "$project" "$registry_secret" "$source_sha" \
  "$(wc -c < "$asr_file" | tr -d ' ')" "$asr_sha256" \
  "$(wc -c < "$ranker_file" | tr -d ' ')" "$ranker_sha256" \
  "$fluid_bytes" "$fluid_sha256" <<'PY'
import json
import sys

(
    environment,
    project,
    registry_secret,
    source_sha,
    asr_bytes,
    asr_sha256,
    ranker_bytes,
    ranker_sha256,
    fluid_bytes,
    fluid_sha256,
) = sys.argv[1:]
summary = {
    "environment": environment,
    "project": project,
    "registry_secret": registry_secret,
    "source_sha": source_sha,
    "asr_bytes": int(asr_bytes),
    "asr_sha256": asr_sha256,
    "ranker_bytes": int(ranker_bytes),
    "ranker_sha256": ranker_sha256,
    "fluid_audio": None,
}
if fluid_bytes and fluid_sha256:
    summary["fluid_audio"] = {"bytes": int(fluid_bytes), "sha256": fluid_sha256}
print(json.dumps(summary, sort_keys=True))
PY
