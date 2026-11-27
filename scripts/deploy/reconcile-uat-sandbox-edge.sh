#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
# Compatibility entrypoint delegating UAT sandbox cluster and Edge Gateway
# reconciliation to the unified multi-environment reconciler (requires immutable @sha256: digest).

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-${PROJECT_ID:-}}"
if [[ "${PROJECT_ID}" != "hushh-pda-uat" ]]; then
  echo "UAT Sandbox Edge reconcile: skipping non-UAT project (${PROJECT_ID:-unset})." >&2
  exit 0
fi

if [[ -n "${HUSSH_SANDBOX_EDGE_IMAGE:-}" && "${HUSSH_SANDBOX_EDGE_IMAGE}" != *@sha256:* ]]; then
  echo "UAT Sandbox Edge reconcile: refusing mutable image reference (${HUSSH_SANDBOX_EDGE_IMAGE})." >&2
  exit 1
fi

exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/reconcile-sandbox-cluster.sh" "$@"
