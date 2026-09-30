"""Field-level sensitivity: one field can be an identifier inside a standard item.

``scope_sensitivity`` answers for a whole scope. That is not enough on its own:
localhost acceptance run 4 (2026-09-29, S3) showed the same EIN marked
sensitive under "Tax record" and standard as "Fein" under "Legal entity
information", so a Legal entity follow-up would have sent the EIN to the model.

This module is the field-level half of the same rule (CONTRACT-2 C7):

* An identifier-class KEY is sensitive in any domain: SSN, SIN, national id,
  tax id / TIN / EIN / FEIN / ITIN, passport, driver license, account and
  routing numbers, IBAN, card number, CVV, date of birth, government id
  numbers, security answers, and anything secret-shaped.
* An identifier-shaped VALUE is sensitive under any key: an SSN, EIN, a
  Luhn-valid card number, an IBAN, or a credential string.
* Everything else in a standard item stays standard, so One can still answer
  from "Trade name" or "Favorite restaurant".

The words, phrases and value patterns live in
``contracts/consent/field-sensitivity.v1.json`` so the client can apply the
identical rule before it builds ``sharedInformation``; the server applies it
again at continuation admission (defense in depth).

Pure: no database, no network, no model. A pod can import it.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Sequence
from functools import lru_cache
from itertools import pairwise
from typing import Any, Literal

from hushh_mcp.consent.internal_path_keys import is_secret_shaped_key
from hushh_mcp.consent.segment_labels import humanize_segment
from hushh_mcp.services.generated_contracts import generated_contract_path

FieldSensitivity = Literal["sensitive", "standard"]

_CONTRACT_PATH = generated_contract_path("consent", "field-sensitivity.v1.json")
_WORD = re.compile(r"[a-z0-9]+")
_NON_DIGIT = re.compile(r"\D+")


@lru_cache(maxsize=1)
def _contract() -> dict[str, Any]:
    with _CONTRACT_PATH.open("r", encoding="utf-8") as handle:
        contract: dict[str, Any] = json.load(handle)
    return contract


@lru_cache(maxsize=1)
def _key_words() -> frozenset[str]:
    return frozenset(str(word).lower() for word in _contract()["identifier_key_words"])


@lru_cache(maxsize=1)
def _key_phrases() -> frozenset[tuple[str, str]]:
    return frozenset(
        (str(left).lower(), str(right).lower())
        for left, right in _contract()["identifier_key_phrases"]
    )


@lru_cache(maxsize=1)
def _filler_words() -> frozenset[str]:
    return frozenset(str(word).lower() for word in _contract()["filler_words"])


@lru_cache(maxsize=1)
def _value_patterns() -> tuple[tuple[re.Pattern[str], bool], ...]:
    return tuple(
        (re.compile(str(entry["pattern"])), bool(entry.get("luhn")))
        for entry in _contract()["identifier_value_patterns"]
    )


@lru_cache(maxsize=1)
def sensitive_topic_words() -> frozenset[str]:
    """Every word that names a sensitive topic, across the contract's topics."""
    return frozenset(
        str(word).lower()
        for topic in _contract()["sensitive_topics"].values()
        for word in topic["words"]
    )


@lru_cache(maxsize=1)
def sensitive_topic_phrases() -> frozenset[tuple[str, str]]:
    """Two-word phrases whose words are harmless alone ("social", "account")."""
    return frozenset(
        (str(left).lower(), str(right).lower())
        for topic in _contract()["sensitive_topics"].values()
        for left, right in topic["phrases"]
    )


def _key_words_of(segment: str) -> list[str]:
    """Whole words of one key, camelCase-aware, plural folded, filler removed."""
    words = _WORD.findall(humanize_segment(segment).lower())
    folded = [word[:-1] if len(word) > 3 and word.endswith("s") else word for word in words]
    return [word for word in folded if word not in _filler_words()]


def _luhn_ok(digits: str) -> bool:
    total = 0
    for index, char in enumerate(reversed(digits)):
        value = int(char)
        if index % 2 == 1:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


def field_key_is_sensitive(key_path: str | Sequence[str]) -> bool:
    """Whether a field key (or any key on its path) is identifier-class.

    ``key_path`` is one key (``"fein"``, ``"entity fein"``, ``"taxId"``) or the
    keys from the item down to the value. Any identifier-class key on the path
    makes the field sensitive; a phrase may straddle two keys
    (``national > id``).
    """
    keys = [key_path] if isinstance(key_path, str) else list(key_path)
    joined: list[str] = []
    for key in keys:
        text = str(key or "").strip()
        if not text:
            continue
        if is_secret_shaped_key(text):
            return True
        words = _key_words_of(text)
        if any(word in _key_words() for word in words):
            return True
        joined.extend(words)
    return any(pair in _key_phrases() for pair in pairwise(joined))


def value_is_identifier_shaped(value: Any) -> bool:
    """Whether a value looks like an identifier (SSN, EIN, card, IBAN, credential)."""
    if value is None or isinstance(value, bool):
        return False
    text = str(value)
    if not text.strip():
        return False
    for pattern, luhn in _value_patterns():
        for match in pattern.finditer(text):
            if not luhn or _luhn_ok(_NON_DIGIT.sub("", match.group(0))):
                return True
    return False


def field_sensitivity(key_path: str | Sequence[str], value: Any = None) -> FieldSensitivity:
    """``"sensitive"`` or ``"standard"`` for one field of a shared item."""
    if field_key_is_sensitive(key_path) or value_is_identifier_shaped(value):
        return "sensitive"
    return "standard"


def sensitive_field_names(names: Iterable[str]) -> list[str]:
    """The names in ``names`` whose key alone makes them sensitive, in order."""
    return [name for name in names if field_key_is_sensitive(name)]


__all__ = [
    "FieldSensitivity",
    "field_key_is_sensitive",
    "field_sensitivity",
    "sensitive_field_names",
    "value_is_identifier_shaped",
]
