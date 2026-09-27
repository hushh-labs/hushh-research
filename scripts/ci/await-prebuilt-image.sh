#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
#
# Wait for an image build that a deploy lane started with
# `gcloud builds submit --async`, then pin the exact image it pushed.
#
# The deploy lanes start the frontend image build at the same moment as the
# backend image build and only come back for it right before the frontend
# deploy. This script is the "come back" half:
#
#   1. streams the build log into the calling step (best effort),
#   2. waits for the build's terminal status and fails on anything but SUCCESS,
#   3. resolves the pushed tag to an immutable sha256 digest once, and
#   4. pins the executable linux/amd64 manifest the same way the backend lane
#      does (scripts/ci/resolve-cloud-run-image.py), so Cloud Run later reports
#      exactly this digest.
#
# stdout carries exactly one line, the pinned `<repository>@sha256:<digest>`.
# Everything else goes to stderr so callers can capture stdout safely.
#
# Usage:
#   await-prebuilt-image.sh --project P --build-id ID --image-repository R \
#     --image-tag T --sha S --manifest-json FILE --json-output FILE \
#     [--timeout-seconds N] [--poll-seconds N]
set -euo pipefail

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//' >&2
}

project=""
build_id=""
image_repository=""
image_tag=""
sha=""
manifest_json=""
json_output=""
timeout_seconds="2400"
poll_seconds="10"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) project="${2:-}"; shift 2 ;;
    --build-id) build_id="${2:-}"; shift 2 ;;
    --image-repository) image_repository="${2:-}"; shift 2 ;;
    --image-tag) image_tag="${2:-}"; shift 2 ;;
    --sha) sha="${2:-}"; shift 2 ;;
    --manifest-json) manifest_json="${2:-}"; shift 2 ;;
    --json-output) json_output="${2:-}"; shift 2 ;;
    --timeout-seconds) timeout_seconds="${2:-}"; shift 2 ;;
    --poll-seconds) poll_seconds="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

for required in project build_id image_repository image_tag sha manifest_json json_output; do
  if [ -z "${!required}" ]; then
    echo "Missing required --${required//_/-}." >&2
    exit 2
  fi
done
if [[ ! "${build_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "Refusing to wait on '${build_id}': not a Cloud Build id." >&2
  exit 2
fi
if [[ ! "${image_repository}" =~ ^gcr\.io/[a-z][a-z0-9-]{4,28}[a-z0-9]/[a-z0-9._/-]+$ ]]; then
  echo "Refusing image repository '${image_repository}': expected gcr.io/<project>/<image>." >&2
  exit 2
fi
if [[ ! "${timeout_seconds}" =~ ^[0-9]+$ || ! "${poll_seconds}" =~ ^[0-9]+$ ]]; then
  echo "--timeout-seconds and --poll-seconds must be non-negative integers." >&2
  exit 2
fi

echo "Waiting for image build ${build_id} (${image_repository}:${image_tag})." >&2

# The log is for humans reading this step; the build status below is the
# authority. A stream that ends early must never be read as success.
if ! gcloud builds log --stream "${build_id}" --project="${project}" >&2; then
  echo "Build log stream ended early; polling the build status instead." >&2
fi

deadline=$((SECONDS + timeout_seconds))
while :; do
  status="$(gcloud builds describe "${build_id}" --project="${project}" --format='value(status)')"
  case "${status}" in
    SUCCESS)
      break
      ;;
    QUEUED|PENDING|WORKING)
      ;;
    *)
      echo "Image build ${build_id} finished with status '${status:-unknown}', not SUCCESS." >&2
      echo "Its full log: gcloud builds log ${build_id} --project=${project}" >&2
      exit 1
      ;;
  esac
  if [ "${SECONDS}" -ge "${deadline}" ]; then
    echo "Image build ${build_id} did not finish within ${timeout_seconds}s (last status ${status})." >&2
    exit 1
  fi
  sleep "${poll_seconds}"
done

image_digest="$(gcloud container images describe \
  "${image_repository}:${image_tag}" \
  --project="${project}" \
  --format='value(image_summary.digest)')"
if [[ ! "${image_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Image build ${build_id} did not resolve an immutable sha256 digest." >&2
  exit 1
fi
image_reference="${image_repository}@${image_digest}"

# Buildx attestations live in a parent index. Pin its executable child; Cloud
# Run must later report this exact digest.
gcloud auth configure-docker gcr.io --quiet >&2
docker buildx imagetools inspect --raw "${image_reference}" > "${manifest_json}"
python3 scripts/ci/resolve-cloud-run-image.py \
  --image-reference "${image_reference}" \
  --manifest-json "${manifest_json}" \
  --sha "${sha}" \
  --json-output "${json_output}"
