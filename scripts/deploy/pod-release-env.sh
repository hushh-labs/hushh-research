#!/usr/bin/env bash
# Immutable build artifacts shared by Cloud Build steps; also used by deploy rehearsals.
read_dev_pod_release() {
  if [[ "${1:?build mode required}" == "true" ]]; then
    read_pod_release_artifacts "${2:?workspace required}"
  else
    read_existing_dev_pod_release "${3:?project required}" "${4:?region required}" "${5:?service required}"
  fi
  pod_browser_review_enabled="$(printf '%s' "$pod_release_b64" | \
    python3 "$(dirname "${BASH_SOURCE[0]}")/preserve-pod-release.py" \
    --browser-review-image "$pod_image")" || return 1
}

read_pod_release_artifacts() {
  local workspace="${1:?workspace required}"
  local pod_image_file="${workspace}/pod-image-reference"
  if [[ ! -s "$pod_image_file" ]]; then
    echo "pod image digest record is missing; refusing mutable pod target" >&2
    exit 1
  fi
  pod_image="$(head -n 1 "$pod_image_file" | tr -d '\r\n')"
  if [[ ! "$pod_image" =~ ^.+@sha256:[0-9a-fA-F]{64}$ ]]; then
    echo "pod image digest record is invalid; refusing mutable pod target" >&2
    exit 1
  fi
  if [[ ! -s "${workspace}/pod-release.b64" ]]; then
    echo "pod release metadata is missing; refusing an unverified release" >&2
    exit 1
  fi
  pod_release_b64="$(tr -d '\r\n' < "${workspace}/pod-release.b64")"
}

# --set-env-vars replaces the service environment. An application-only deploy
# must retain the existing immutable offer, with its original image provenance.
read_existing_dev_pod_release() {
  local project="${1:?project required}" region="${2:?region required}" service="${3:?service required}"
  local offered
  offered="$(gcloud run services describe "$service" --project="$project" --region="$region" \
    --format='json(status.traffic,status.latestReadyRevisionName)' 2>/dev/null | \
    python3 "$(dirname "${BASH_SOURCE[0]}")/preserve-pod-release.py" \
    --project="$project" --region="$region")" || {
    echo "Existing dev pod offer read failed; refusing deployment" >&2
    return 1
  }
  IFS='|' read -r pod_image pod_release_b64 <<< "$offered"
}
