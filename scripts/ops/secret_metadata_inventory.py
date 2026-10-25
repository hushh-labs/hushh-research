"""Bounded, fail-closed metadata inventory for explicitly selected secret names."""

from __future__ import annotations

import subprocess
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor


class CloudReadUnavailable(RuntimeError):
    """Cloud access failed; absence cannot be inferred from this observation."""


def has_secret(project: str, name: str) -> bool:
    cmd = [
        "gcloud",
        "secrets",
        "describe",
        name,
        "--project",
        project,
        "--format=value(name)",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CloudReadUnavailable("secret_inventory_unverifiable") from exc
    if result.returncode == 0 and result.stdout.strip():
        return True
    if result.returncode != 0 and "NOT_FOUND" in result.stderr:
        return False
    # Unknown reads never establish absence. Keep provider diagnostics private.
    raise CloudReadUnavailable("secret_inventory_unverifiable")


def missing_secrets(
    project: str, names: tuple[str, ...], describe: Callable[[str, str], bool]
) -> list[str]:
    """Keep report order and settle every started metadata read before returning."""
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = pool.map(lambda name: describe(project, name), names)
        return [name for name, present in zip(names, results, strict=True) if not present]
