"""Private workdir rules and the public-output allowlist.

Private: originals, page text, labels, model outputs. They live only in a 0700
workdir outside every git worktree. Public (report.public.json, stdout, CI
artifacts): counts, enums, versions and keyed ids only. Free text, names,
issuers and account numbers cannot pass ``public_payload``.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import stat
from collections.abc import Iterable
from pathlib import Path
from typing import Any

SAFE_TOKEN = re.compile(r"^[a-z0-9][a-z0-9_.:/+-]{0,95}$")
SAFE_KEY = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
MIN_PRIVATE_STRING = 4


class PrivacyError(RuntimeError):
    """A privacy rule refused an operation; the message is a fixed code."""


def inside_git_worktree(path: Path) -> bool:
    current = path.resolve()
    for candidate in (current, *current.parents):
        if (candidate / ".git").exists():
            return True
    return False


class PrivateWorkdir:
    """A 0700 directory outside git; every file it writes is 0600."""

    def __init__(self, path: Path, *, create: bool = True):
        if not path.is_absolute():
            raise PrivacyError("workdir_must_be_absolute")
        if inside_git_worktree(path if path.exists() else path.parent):
            raise PrivacyError("workdir_inside_git_worktree")
        if not path.exists():
            if not create:
                raise PrivacyError("workdir_missing")
            path.mkdir(mode=0o700, parents=True)
            path.chmod(0o700)
        details = path.stat()
        if not stat.S_ISDIR(details.st_mode) or path.is_symlink():
            raise PrivacyError("workdir_not_directory")
        if stat.S_IMODE(details.st_mode) != 0o700:
            raise PrivacyError("workdir_mode_not_0700")
        if details.st_uid != os.getuid():
            raise PrivacyError("workdir_not_owned")
        self.path = path

    def directory(self, *parts: str) -> Path:
        target = self.path.joinpath(*parts)
        if not target.resolve().is_relative_to(self.path.resolve()):
            raise PrivacyError("path_outside_workdir")
        current = self.path
        for part in parts:
            # Every component, not only the leaf: mkdir(parents=True) would
            # create intermediate directories with the process umask.
            current = current / part
            current.mkdir(mode=0o700, exist_ok=True)
            current.chmod(0o700)
        return target

    def write_bytes(self, target: Path, content: bytes) -> Path:
        if not target.resolve().is_relative_to(self.path.resolve()):
            raise PrivacyError("path_outside_workdir")
        descriptor = os.open(target, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
        return target

    def write_json(self, target: Path, value: Any) -> Path:
        return self.write_bytes(
            target, (json.dumps(value, indent=2, sort_keys=True, default=str) + "\n").encode()
        )

    def salt(self) -> bytes:
        """Per-workdir HMAC key: stable keyed ids across batches, never published."""
        path = self.path / "salt.key"
        if not path.exists():
            self.write_bytes(path, secrets.token_hex(32).encode())
        if stat.S_IMODE(path.stat().st_mode) != 0o600:
            raise PrivacyError("salt_mode_not_0600")
        return bytes.fromhex(path.read_text().strip())


def keyed(salt: bytes, kind: str, value: str) -> str:
    """A keyed, non-reversible identifier. Raw Drive or database ids never leave."""
    return hmac.new(salt, f"{kind}\0{value}".encode(), hashlib.sha256).hexdigest()[:32]


def public_payload(value: Any, *, path: str = "$") -> Any:
    """Return ``value`` unchanged only if every key and string is an allowlisted token."""
    if value is None or isinstance(value, bool | int):
        return value
    if isinstance(value, float):
        if value != value or value in {float("inf"), float("-inf")}:
            raise PrivacyError(f"public_non_finite:{path}")
        return value
    if isinstance(value, str):
        if not SAFE_TOKEN.fullmatch(value):
            raise PrivacyError(f"public_free_text:{path}")
        return value
    if isinstance(value, list | tuple):
        return [public_payload(item, path=f"{path}[{index}]") for index, item in enumerate(value)]
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if not isinstance(key, str) or not SAFE_KEY.fullmatch(key):
                raise PrivacyError(f"public_key_rejected:{path}")
            result[key] = public_payload(item, path=f"{path}.{key}")
        return result
    raise PrivacyError(f"public_type_rejected:{path}")


def private_strings(values: Iterable[Any]) -> set[str]:
    """Collect every private string (labels, page text fragments, model claims)."""
    found: set[str] = set()

    def visit(item: Any) -> None:
        if isinstance(item, str):
            for part in re.split(r"[\n\r\t]+", item):
                part = part.strip()
                if len(part) >= MIN_PRIVATE_STRING and not part.isdigit():
                    found.add(part.casefold())
        elif isinstance(item, dict):
            for child in item.values():
                visit(child)
        elif isinstance(item, list | tuple | set):
            for child in item:
                visit(child)

    for value in values:
        visit(value)
    return found


# Placeholder and vocabulary words that models write as values (an issuer of
# "Unknown") and that the reports themselves use. A single such word identifies
# no one; names, numbers and multi-word values are always checked.
GENERIC_WORDS = frozenset(
    {
        "unknown",
        "unspecified",
        "document",
        "documents",
        "statement",
        "statements",
        "packet",
        "packets",
        "request",
        "requests",
        "record",
        "records",
        "receipt",
        "receipts",
        "report",
        "reports",
        "incomplete",
        "complete",
        "pending",
        "family",
        "labels",
        "extraction",
        "accuracy",
        "independent",
        "insufficient",
        "replay",
        "served",
        "delivery",
        "period",
        "periods",
        "unverified",
        "invoice",
        "invoices",
    }
)


def assert_public_text(text: str, *, canaries: Iterable[str] = (), private: Iterable[str] = ()):
    """Public text may not contain a planted canary or any known private value."""
    folded = text.casefold()
    for canary in canaries:
        if canary and canary.casefold() in folded:
            raise PrivacyError("canary_leak")
    for value in private:
        if len(value) < 6 or value in GENERIC_WORDS:
            continue
        # Whole-word match: a value is a leak, a coincidental slice of a
        # template token (for example inside "packet_completeness") is not.
        if re.search(rf"(?<![a-z0-9]){re.escape(value)}(?![a-z0-9])", folded):
            raise PrivacyError("private_value_leak")
    return text
