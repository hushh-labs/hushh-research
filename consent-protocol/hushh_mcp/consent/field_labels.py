"""Human names for field keys and enum-like values ("Fein" -> "Federal EIN").

A humanizer turns ``naics_code`` into "Naics code" and leaves ``C_CORP`` as it
is; both reached a person on the person page and in the secure card
(localhost acceptance run 4, 2026-09-29, S3 and U3). The fixed names live in
``contracts/consent/field-labels.v1.json`` so the client's secure card and
this server name the same field the same way.

Pure: no database, no network, no model.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from typing import Any

from hushh_mcp.services.generated_contracts import generated_contract_path

_CONTRACT_PATH = generated_contract_path("consent", "field-labels.v1.json")
_FOLD = re.compile(r"[\s\-]+")
# ``C_CORP``, ``MARRIED_FILING_JOINTLY``: a storage enum, never prose.
_ENUM_VALUE = re.compile(r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$")


@lru_cache(maxsize=1)
def _contract() -> dict[str, Any]:
    with _CONTRACT_PATH.open("r", encoding="utf-8") as handle:
        contract: dict[str, Any] = json.load(handle)
    return contract


def _key(raw: str) -> str:
    return _FOLD.sub("_", str(raw or "").strip().lower()).strip("_")


def known_field_label(key: str | None) -> str | None:
    """The fixed human name for a field key, or None when the key is not listed."""
    labels: dict[str, str] = _contract()["key_labels"]
    normalized = _key(str(key or ""))
    if not normalized:
        return None
    if normalized in labels:
        return labels[normalized]
    # "entity_fein" names the same field as "fein" under its parent's word.
    head, _, rest = normalized.partition("_")
    return labels.get(rest) if head and rest else None


def human_value_label(value: Any) -> Any:
    """A readable form of an enum-like value ("C_CORP" -> "C corporation").

    Anything that is not an upper-case storage enum is returned unchanged, so
    names, amounts and free text are never rewritten.
    """
    if not isinstance(value, str):
        return value
    text = value.strip()
    labels: dict[str, str] = _contract()["value_labels"]
    if text in labels:
        return labels[text]
    if not _ENUM_VALUE.fullmatch(text):
        return value
    words = text.replace("_", " ").lower()
    return words[:1].upper() + words[1:]


__all__ = ["human_value_label", "known_field_label"]
