#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" == frontend && -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use 24 >/dev/null
fi
exec "$root/consent-protocol/.venv/bin/python" "$root/Personal_Tasks/akshat-sandbox.py" "$@"
