#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
# Xcode 26.3 predates SwiftPM's per-artifact cache lock (upstream PR 10203).
# Retry only its cold-download collision; never retry compilation or tests.
set -uo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${XCODE_PROJECT:?XCODE_PROJECT is required}"
: "${XCODE_SCHEME:?XCODE_SCHEME is required}"

for attempt in 1 2; do
  log="${RUNNER_TEMP}/xcodebuild-package-resolution-${attempt}.log"
  xcodebuild -resolvePackageDependencies \
    -project "${XCODE_PROJECT}" \
    -scheme "${XCODE_SCHEME}" \
    -packageCachePath "${RUNNER_TEMP}/spm-cache" \
    -clonedSourcePackagesDirPath "${RUNNER_TEMP}/spm" \
    2>&1 | tee "$log"
  statuses=("${PIPESTATUS[@]}")
  if [[ "${statuses[1]}" != 0 ]]; then
    exit "${statuses[1]}"
  fi
  result="${statuses[0]}"
  if [[ "$result" == 0 ]]; then
    exit 0
  fi
  if [[ "$attempt" == 2 || "$result" != 74 ]]; then
    exit "$result"
  fi

  collision=false
  other_resolution_failure=false
  while IFS= read -r line; do
    if [[ "$line" == *"failed downloading '"* ]]; then
      if [[ "$line" == *"which is required by binary target '"* &&
            "$line" == *": ${RUNNER_TEMP}/spm-cache/artifacts/"*" already exists in file system"* ]]; then
        collision=true
      else
        other_resolution_failure=true
      fi
    fi
    diagnostic="${line#*failed downloading }"
    if [[ "$line" == *"checksum"* || "$line" == *"signature"* ||
          ( "$line" == *"error:"* &&
            "$line" != *"xcodebuild: error: Could not resolve package dependencies:"* &&
            "$line" != "error: failed downloading '"* ) ||
          ( "$line" == *"failed downloading '"* && "$diagnostic" == *"error:"* ) ]]; then
      other_resolution_failure=true
    fi
  done < "$log"
  if [[ "$collision" != true || "$other_resolution_failure" == true ]]; then
    exit "$result"
  fi
  echo "::warning::SwiftPM artifact-cache collision; retrying resolution once with the verified cache retained."
done
