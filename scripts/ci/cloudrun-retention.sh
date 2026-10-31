#!/usr/bin/env bash
set -euo pipefail

# Existing prevalidation workflow calls are dry runs until moved after health.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "${SCRIPT_DIR}/cloudrun-retention.py" "$@"
