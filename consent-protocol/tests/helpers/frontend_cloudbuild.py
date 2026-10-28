"""Guarded Cloud Build shell adapter for frontend contract tests."""

from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]


def _bash() -> str:
    bash = shutil.which("bash")
    assert bash is not None, "Bash is required to run the deploy step bodies"
    return bash


def _steps(path: Path) -> dict[str, dict]:
    config = yaml.safe_load(path.read_text(encoding="utf-8"))
    return {step["id"]: step for step in config["steps"]}


def _body(step: dict) -> str:
    assert step["entrypoint"] == "bash"
    assert step["args"][0] == "-c"
    return str(step["args"][1])


def _without_first_line(script: str) -> str:
    first, _, rest = script.partition("\n")
    assert first == "set -euo pipefail"
    return rest


def _substitute(script: str, values: dict[str, str]) -> str:
    """Apply Cloud Build's simple ${_NAME} substitution, nothing else."""

    def replace(match: re.Match[str]) -> str:
        return values[match.group(1)]

    # Cloud Build passes these substitutions as environment values, never as
    # shell source. Quote synthetic values to reproduce that boundary in Bash.
    names = {
        "_DEPLOY_ENV": "PLG_FRONTEND_DEPLOY_ENV",
        "_APP_ENV": "PLG_FRONTEND_APP_ENV",
        "_IMAGE_TAG": "PLG_FRONTEND_IMAGE_TAG",
        "_IMAGE_PUBLISH_MODE": "PLG_FRONTEND_PUBLISH_MODE",
    }
    exports = "".join(
        f"export {target}={shlex.quote(values[source])}\n"
        for source, target in names.items()
        if source in values
    )
    return exports + re.sub(r"\$\{(_[A-Z0-9_]+)\}", replace, script)


def _run(script: str, *, env: dict[str, str] | None = None, cwd: Path = ROOT):
    environment = os.environ.copy()
    environment.pop("BASH_ENV", None)
    environment.update(env or {})
    return subprocess.run(  # noqa: S603 - trusted repo scripts, fixed inputs, guarded commands
        [_bash(), "-c", script],
        cwd=cwd,
        env=environment,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
