"""Read authorities carried by the existing environment-bound secret binding.

The optional UAT envelope contains independent keys, not a shared signing key.
Parsing is local and bounded; it grants no collection or delivery permission.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable

UAT_OWNER = "ONE_PLG_UAT_EXPORT_SECRET"
UAT_DIRECTORY = "ONE_PLG_UAT_AUDIENCE_SECRET"


def _unique_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Invalid UAT read configuration")
        value[key] = item
    return value


def _uat_settings() -> tuple[str, str, bool]:
    raw = os.getenv(UAT_OWNER, "")
    if len(raw) > 4096:
        return "", "", False
    if not raw.lstrip().startswith(("{", "[")):
        # Existing flat keys retain their previous, separately configured gate.
        return (
            raw,
            os.getenv(UAT_DIRECTORY, ""),
            os.getenv("ONE_PLG_UAT_AUDIENCE_ENABLED") == "true",
        )
    # Mixed configuration has ambiguous rotation/activation semantics. Refuse it.
    if os.getenv(UAT_DIRECTORY) or "ONE_PLG_UAT_AUDIENCE_ENABLED" in os.environ:
        return "", "", False
    try:
        value = json.loads(raw, object_pairs_hook=_unique_pairs)
    except (ValueError, RecursionError):
        return "", "", False
    fields = {
        "version",
        "environment",
        "project",
        "ownerReadKey",
        "audienceReadKey",
        "audienceEnabled",
    }
    if (
        not isinstance(value, dict)
        or set(value) != fields
        or type(value["version"]) is not int
        or value["version"] != 1
        or value["environment"] != "uat"
        or value["project"] != "hushh-pda-uat"
        or type(value["audienceEnabled"]) is not bool
    ):
        return "", "", False
    owner, directory = value["ownerReadKey"], value["audienceReadKey"]
    if (
        any(
            not isinstance(key, str)
            or not 32 <= len(key) <= 512
            or any(not 33 <= ord(char) <= 126 for char in key)
            for key in (owner, directory)
        )
        or owner == directory
    ):
        return "", "", False
    return owner, directory, value["audienceEnabled"]


def read_secret(name: str) -> str:
    if name == UAT_OWNER:
        return _uat_settings()[0]
    if name == UAT_DIRECTORY:
        return _uat_settings()[1]
    return os.getenv(name, "")


def secret_in_use(secret: str, names: Iterable[str]) -> bool:
    """Check both mounted and effective keys, including reciprocal worker isolation."""
    return any(secret in {os.getenv(name, ""), read_secret(name)} for name in names)


def uat_directory_enabled() -> bool:
    return _uat_settings()[2]
