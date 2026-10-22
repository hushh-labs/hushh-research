"""Preserve the deliberately configured dev ciphertext pilot during deploy sync."""

from __future__ import annotations

import re
from typing import Any


def apply_policy(config: dict[str, Any], retained: dict[str, Any]) -> dict[str, Any]:
    enabled = retained.get("hussh_shared_files_enabled", False)
    if not (
        enabled is True
        or enabled is False
        or (isinstance(enabled, str) and enabled in {"true", "false"})
    ):
        raise ValueError("Shared Files runtime policy is invalid")
    enabled = enabled in {True, "true"} and config.get("environment") == "dev"
    bucket = retained.get("hussh_shared_files_bucket", "") if enabled else ""
    if enabled and (
        not isinstance(bucket, str)
        or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]", bucket)
    ):
        raise ValueError("Shared Files requires an explicit private bucket")
    return {
        **config,
        "hussh_shared_files_enabled": enabled,
        "hussh_shared_files_bucket": bucket,
    }
