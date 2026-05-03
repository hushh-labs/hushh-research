# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Pytest plugin: trailing ``COUNT=N`` repeats the session N times (default 1)."""

from __future__ import annotations

import os
import re
import subprocess
import sys

import pytest
from _pytest.config import ExitCode

_COUNT = re.compile(r"(?i)^count=(\d+)$")
_N = 1


def pytest_load_initial_conftests(
    early_config: pytest.Config,  # noqa: ARG001
    parser: object,  # noqa: ARG001
    args: list[str],
) -> None:
    global _N
    _N = 1
    if not args:
        return
    m = _COUNT.fullmatch(args[-1])
    if not m:
        return
    n = int(m.group(1), 10)
    if n < 1:
        raise pytest.UsageError(f"COUNT must be >= 1; got: {args[-1]}")
    args.pop()
    _N = n


@pytest.hookimpl(hookwrapper=True, trylast=True)
def pytest_cmdline_main(config: pytest.Config):
    outcome = yield
    if _N <= 1:
        return
    try:
        rc = outcome.get_result()
    except BaseException:
        raise
    if rc not in (0, ExitCode.OK):
        return
    stripped = list(config.invocation_params.args)
    if stripped and _COUNT.fullmatch(stripped[-1]):
        stripped = stripped[:-1]
    env = os.environ.copy()
    env.pop("PYTEST_ADDOPTS", None)
    for _ in range(2, _N + 1):
        proc = subprocess.run(  # noqa: S603
            [sys.executable, "-m", "pytest", *stripped],
            cwd=config.invocation_params.dir,
            env=env,
            check=False,
        )
        if proc.returncode not in (0, int(ExitCode.OK)):
            outcome.force_result(proc.returncode)
            return
