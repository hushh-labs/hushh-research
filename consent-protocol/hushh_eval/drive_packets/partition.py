"""Held-out split by family, frozen by content hash, with a permanent burn list.

A family is HMAC(issuer, account last 4 or subject, document type) from labels;
without labels it falls back to the folder cluster so correlated files stay
together. 30% of families are held out by HMAC(salt, family). Held-out results
are aggregates only. Viewing a held-out item burns it to dev and is logged.
Contaminated evidence (seven-source files, incident files, priority originals,
the synthetic v1 held-out set) is burned forever.
"""

from __future__ import annotations

import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path

from hushh_eval.drive_packets.privacy import keyed

HELDOUT_FRACTION = 0.30
BURN_REASONS = {
    "seven_source",
    "incident",
    "priority_original",
    "synthetic_v1_heldout",
    "viewed",
    "legacy_label",
}


def _norm(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").casefold()).strip()


def account_last4(value: object) -> str:
    digits = re.findall(r"\d", str(value or ""))
    return "".join(digits[-4:]) if len(digits) >= 4 else ""


def family_key(
    salt: bytes,
    *,
    issuer: object,
    account: object,
    subject: object,
    document_type: object,
    fallback: str | None,
) -> str:
    anchor = account_last4(account) or _norm(subject)
    if _norm(issuer) and _norm(document_type):
        material = "|".join((_norm(issuer), anchor, _norm(document_type)))
        return keyed(salt, "family", material)
    return keyed(salt, "family-fallback", fallback or "unlabeled")


def assign(salt: bytes, family: str) -> str:
    bucket = int(keyed(salt, "heldout", family)[:8], 16) / 0xFFFFFFFF
    return "heldout" if bucket < HELDOUT_FRACTION else "dev"


class BurnList:
    """Append-only, keyed by content sha256 or file key. Burned is dev forever."""

    def __init__(self, path: Path):
        self.path = path
        self._items: dict[str, str] = {}
        if path.exists():
            for line in path.read_text().splitlines():
                if line.strip():
                    row = json.loads(line)
                    self._items[row["key"]] = row["reason"]

    def burned(self, *keys: str | None) -> bool:
        return any(key and key in self._items for key in keys)

    def burn(self, key: str, reason: str) -> None:
        if reason not in BURN_REASONS:
            raise ValueError("unknown_burn_reason")
        if key in self._items:
            return
        self._items[key] = reason
        row = {"key": key, "reason": reason, "at": datetime.now(UTC).isoformat()}
        descriptor = os.open(self.path, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
        with os.fdopen(descriptor, "a") as handle:
            handle.write(json.dumps(row, sort_keys=True) + "\n")

    def view_heldout(self, *, case_key: str, content_sha256: str | None) -> None:
        """Any human or tool view of a held-out item burns it to dev (logged)."""
        self.burn(case_key, "viewed")
        if content_sha256:
            self.burn(content_sha256, "viewed")


def partition_for(
    salt: bytes,
    burn: BurnList,
    *,
    family: str,
    file_key: str,
    content_sha256: str | None,
    frozen_sha256: str | None,
) -> tuple[str, str | None]:
    """Return (partition, status). A changed original is excluded from held-out scores."""
    if burn.burned(file_key, content_sha256):
        return "dev", "burned"
    if frozen_sha256 and content_sha256 and frozen_sha256 != content_sha256:
        return "dev", "source_changed"
    return assign(salt, family), None
