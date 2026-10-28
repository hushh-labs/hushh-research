"""Prepare a small hash-pinned capacity reader runtime.

The versions and allowed wheel hashes come directly from this Main checkout's
protocol lock. No application environment or provider state is mutated.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PACKAGES = frozenset({"pathspec", "pyyaml"})


def locked_requirements(lock_bytes):
    lock = tomllib.loads(lock_bytes.decode("utf-8"))
    selected = [row for row in lock["package"] if row.get("name") in PACKAGES]
    if {row.get("name") for row in selected} != PACKAGES or len(selected) != 2:
        raise ValueError("capacity dependency lock is incomplete")
    lines = []
    for row in sorted(selected, key=lambda item: item["name"]):
        version = row.get("version")
        wheels = row.get("wheels")
        if not isinstance(version, str) or not re.fullmatch(
            r"[0-9]+(?:\.[0-9]+)+", version
        ):
            raise ValueError("capacity dependency version is invalid")
        if not isinstance(wheels, list) or not wheels:
            raise ValueError("capacity dependency wheels are missing")
        hashes = sorted({item.get("hash") for item in wheels if isinstance(item, dict)})
        if not hashes or any(
            not isinstance(value, str)
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", value)
            for value in hashes
        ):
            raise ValueError("capacity dependency hash is invalid")
        lines.append(
            f"{row['name']}=={version} "
            + " ".join(f"--hash={value}" for value in hashes)
        )
    return "\n".join(lines) + "\n"


def prepare(destination, run=subprocess.run):
    if destination.exists():
        raise ValueError("capacity runtime scope is invalid")
    lock_bytes = (ROOT / "consent-protocol/uv.lock").read_bytes()
    requirements = locked_requirements(lock_bytes)
    run(
        [sys.executable, "-m", "venv", str(destination)],
        check=True,
        capture_output=True,
        timeout=90,
    )
    python = destination / (
        "Scripts/python.exe" if sys.platform == "win32" else "bin/python"
    )
    requirement_file = destination / "capacity-requirements.txt"
    requirement_file.write_text(requirements, encoding="utf-8")
    run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-deps",
            "--only-binary=:all:",
            "--require-hashes",
            "-r",
            str(requirement_file),
        ],
        check=True,
        capture_output=True,
        timeout=120,
    )
    lock = tomllib.loads(lock_bytes.decode("utf-8"))
    versions = {
        row["name"]: row["version"]
        for row in lock["package"]
        if row.get("name") in PACKAGES
    }
    check = "import importlib.metadata as m, json, sys, yaml, pathspec; expected=json.loads(sys.argv[1]); assert all(m.version(k)==v for k,v in expected.items())"
    run(
        [str(python), "-c", check, json.dumps(versions)],
        check=True,
        capture_output=True,
        timeout=15,
    )
    return str(python)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--venv", type=Path)
    mode.add_argument("--verify-frontend-test", action="store_true")
    args = parser.parse_args()
    try:
        if args.verify_frontend_test:
            with tempfile.TemporaryDirectory(prefix="plg-capacity-test-") as folder:
                python = prepare(Path(folder) / "venv")
                subprocess.run(
                    [python, str(ROOT / "scripts/ci/test_runtime_capacity_frontend.py")],
                    cwd=ROOT,
                    check=True,
                    timeout=120,
                )
        else:
            print(prepare(args.venv))
    except Exception:
        print("capacity runtime preparation failed", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
