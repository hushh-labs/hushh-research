#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""The capacity authority-gate tests must not depend on how their CI job started.

Run 41460581860 attempt 2: a re-run of PR Validation by a teammate outside the
production cohort leaked GITHUB_RUN_ATTEMPT=2 and GITHUB_TRIGGERING_ACTOR into
the gate under test, so assert-governed-actor.py refused every accepted case.
Self-running, like the other scripts/ci tests run by repo-governance-check.sh.
"""

# ruff: noqa: S101

from __future__ import annotations

import os
from unittest import mock

from test_verify_deployment_environment_governance import _validate_capacity_trigger

EVENT = {"inputs": {"environment": "production", "healthy_release_run_id": "43", "apply": "false"}}
RERUN = {"GITHUB_RUN_ATTEMPT": "2", "GITHUB_TRIGGERING_ACTOR": "parthmawai"}


def test_runner_rerun_context_does_not_reach_the_gate() -> None:
    with mock.patch.dict(os.environ, RERUN):
        result = _validate_capacity_trigger("workflow_dispatch", EVENT)
    assert result.returncode == 0, f"Runner re-run context reached the gate: {result.stderr}"


def test_gate_still_refuses_an_unauthorized_rerun() -> None:
    denied = _validate_capacity_trigger("workflow_dispatch", EVENT, github=RERUN)
    assert denied.returncode != 0, "An unauthorized production re-run was accepted"
    assert "authorized triggering actor" in denied.stderr, denied.stderr
    allowed = _validate_capacity_trigger("workflow_dispatch", EVENT, github={**RERUN, "GITHUB_TRIGGERING_ACTOR": "kushaltrivedi5"})
    assert allowed.returncode == 0, allowed.stderr


def main() -> int:
    for test in (test_runner_rerun_context_does_not_reach_the_gate, test_gate_still_refuses_an_unauthorized_rerun):
        test()
        print(f"ok {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
