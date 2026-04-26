#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

python3 scripts/ci/verify-protected-pipeline-edits.py
./bin/hushh docs verify
python3 scripts/licenses/verify_apache_surface.py
python3 scripts/ci/verify-runtime-config-contract.py
python3 .codex/skills/agent-orchestration-governance/scripts/agent_orchestration_check.py
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
./bin/hushh db verify-release-contract
