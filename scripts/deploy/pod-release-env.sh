#!/usr/bin/env bash
# Immutable build artifacts shared by Cloud Build steps; also used by deploy rehearsals.
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
