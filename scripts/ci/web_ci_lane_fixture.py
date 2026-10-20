"""Bounded shell fixtures for the existing CI lane-partition contract.

Stub expensive npm/native invocations while retaining real selector and shell
behavior. Every fixture owns and removes its temporary directory.
"""
from __future__ import annotations

import os
import shlex
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _bash() -> str:
    # A Windows WSL shim named bash cannot run this Git Bash contract fixture.
    if os.name == "nt":
        git = shutil.which("git")
        if git:
            directory = Path(git).resolve().parent
            for anchor in (directory, directory.parent, directory.parent.parent):
                for candidate in (anchor / "bash.exe", anchor / "bin/bash.exe"):
                    if candidate.is_file():
                        return str(candidate)
        raise RuntimeError(
            "Git Bash is required to verify web lane partitioning on Windows"
        )
    return "bash"


STUB_NPM = """#!/usr/bin/env bash
if [ "${1:-}" = "run" ]; then
  printf '%s\\n' "$*" >> "$NPM_STUB_LOG"
fi
exit 0
"""


def _run(script: Path, env_overrides: dict[str, str], *, stub_diagrams: bool = False) -> tuple[int, list[str], str]:
    with tempfile.TemporaryDirectory() as tmp:
        stub_dir = Path(tmp) / "bin"
        stub_dir.mkdir()
        npm = stub_dir / "npm"
        npm.write_text(STUB_NPM, encoding="utf-8")
        npm.chmod(npm.stat().st_mode | stat.S_IEXEC)
        log = Path(tmp) / "npm.log"
        log.touch()
        node = stub_dir / "node"
        real_node = shlex.quote(shutil.which("node") or "node")
        diagrams = (
            '  scripts/verify-doc-diagrams.cjs|scripts/render-doc-mermaid.mjs)\n'
            '    printf "%s\\n" "$1" >> "$NPM_STUB_LOG"; exit 0;;\n'
            if stub_diagrams else ""
        )
        node.write_text(
            '#!/usr/bin/env bash\ncase "${1:-}" in\n'
            '  ./scripts/native/verify-native-static-parity.mjs|scripts/observability/verify-android-scope.mjs)\n'
            '    printf "%s\\n" "${1#./}" >> "$NPM_STUB_LOG"; exit 0;;\n'
            '  --test)\n'
            '    if [ "${2:-}" = "scripts/testing/analytics-smoke-failure.test.mjs" ]; then\n'
            '      printf "%s\\n" "$2" >> "$NPM_STUB_LOG"; exit 0; fi;;\n'
            + diagrams + f'esac\nexec {real_node} "$@"\n', encoding="utf-8"
        )
        node.chmod(node.stat().st_mode | stat.S_IEXEC)
        env = dict(os.environ)
        env.update(
            {
                "PATH": f"{stub_dir}{os.pathsep}{env['PATH']}",
                "NPM_STUB_LOG": str(log),
                "WEB_CI_DEPS_INSTALLED": "1",
                "HUSHH_WEB_TEST_MAX_WORKERS": "2",
            }
        )
        env.update(env_overrides)
        proc = subprocess.run(
            [_bash(), str(script)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
        )
        calls = [line for line in log.read_text(encoding="utf-8").splitlines() if line]
        return proc.returncode, calls, proc.stdout + proc.stderr


