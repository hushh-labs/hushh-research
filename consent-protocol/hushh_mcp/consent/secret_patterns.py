"""Which spans of text are secrets, as offsets and kinds, never values.

The Python half of ``contracts/pkm/secret-patterns.v1.json``. The device half,
``hushh-webapp/lib/pkm/secret-patterns.ts``, runs first: it saves each span to
the reserved Secrets area and replaces it with a placeholder before any model,
history or memory proposal sees the text. This module is the server's second
net behind it. It reports WHERE a secret is and WHAT kind it is, so a caller
can refuse or count it, and it deliberately has no way to hand back the value.

Loading is lazy and cached, like ``reserved_branches.py``: the packaged MCP
runtime ships ``hushh_mcp`` without ``contracts/``, so reading the file at
import time would break any module that merely imports this one.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from hushh_mcp.services.generated_contracts import generated_contract_path

_CONTRACT_PATH = generated_contract_path("pkm", "secret-patterns.v1.json")

_ENV_NAME = re.compile(r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$")
_MASK_RUN = re.compile(r"^(.)\1*$")
_DIGIT = re.compile(r"\d")
_NON_ALNUM = re.compile(r"[^A-Za-z0-9]")
_SEPARATORS = re.compile(r"[\s-]")

# Verhoeff checksum tables (dihedral group D5).
_VERHOEFF_D = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    (1, 2, 3, 4, 0, 6, 7, 8, 9, 5),
    (2, 3, 4, 0, 1, 7, 8, 9, 5, 6),
    (3, 4, 0, 1, 2, 8, 9, 5, 6, 7),
    (4, 0, 1, 2, 3, 9, 5, 6, 7, 8),
    (5, 9, 8, 7, 6, 0, 4, 3, 2, 1),
    (6, 5, 9, 8, 7, 1, 0, 4, 3, 2),
    (7, 6, 5, 9, 8, 2, 1, 0, 4, 3),
    (8, 7, 6, 5, 9, 3, 2, 1, 0, 4),
    (9, 8, 7, 6, 5, 4, 3, 2, 1, 0),
)
_VERHOEFF_P = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    (1, 5, 7, 6, 2, 8, 3, 0, 9, 4),
    (5, 8, 0, 3, 7, 9, 6, 1, 4, 2),
    (8, 9, 1, 6, 0, 4, 3, 5, 2, 7),
    (9, 4, 5, 3, 1, 2, 6, 8, 7, 0),
    (4, 2, 8, 6, 5, 7, 3, 9, 0, 1),
    (2, 7, 9, 3, 8, 0, 6, 4, 1, 5),
    (7, 0, 4, 6, 9, 1, 3, 2, 5, 8),
)


@dataclass(frozen=True)
class SecretPattern:
    pattern_id: str
    kind: str
    file_to: str
    regex: re.Pattern[str]
    value_group: int
    validator: str | None


@dataclass(frozen=True)
class SecretSpan:
    """Where a secret sits in a text. Offsets and labels only, by design."""

    start: int
    end: int
    kind: str
    pattern_id: str
    file_to: str


@lru_cache(maxsize=1)
def _contract() -> dict[str, Any]:
    with _CONTRACT_PATH.open("r", encoding="utf-8") as handle:
        contract: dict[str, Any] = json.load(handle)
    return contract


@lru_cache(maxsize=1)
def _patterns() -> tuple[SecretPattern, ...]:
    compiled: list[SecretPattern] = []
    for raw in _contract()["patterns"]:
        flags = re.ASCII | (re.IGNORECASE if raw.get("ignore_case") else 0)
        compiled.append(
            SecretPattern(
                pattern_id=str(raw["id"]),
                kind=str(raw["kind"]),
                file_to=str(raw["file_to"]),
                regex=re.compile(str(raw["pattern"]), flags),
                value_group=int(raw["value_group"]),
                validator=raw.get("validator"),
            )
        )
    return tuple(compiled)


@lru_cache(maxsize=1)
def _placeholder_token() -> re.Pattern[str]:
    return re.compile(str(_contract()["placeholder"]["token_pattern"]))


@lru_cache(maxsize=1)
def _placeholder_words() -> frozenset[str]:
    return frozenset(str(word).lower() for word in _contract()["placeholder_words"])


def _luhn_ok(digits: str) -> bool:
    total = 0
    for index, char in enumerate(reversed(digits)):
        value = ord(char) - 48
        if index % 2 == 1:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


def _verhoeff_ok(digits: str) -> bool:
    check = 0
    for index, char in enumerate(reversed(digits)):
        check = _VERHOEFF_D[check][_VERHOEFF_P[index % 8][ord(char) - 48]]
    return check == 0


def _iban_ok(value: str) -> bool:
    rearranged = value[4:] + value[:4]
    numeric = "".join(str(int(char, 36)) for char in rearranged)
    return int(numeric) % 97 == 1


def _is_reference(value: str) -> bool:
    """True for a NAME of a secret or a stand-in, never a secret itself."""
    lowered = value.lower()
    return bool(
        _ENV_NAME.fullmatch(value)
        or value[:1] in {"$", "%", "<", "{"}
        or "://" in value
        or lowered.startswith("projects/")
        or "/secrets/" in lowered
        or value.startswith(("/", "./", "../", "~/"))
        or _MASK_RUN.fullmatch(value)
        or lowered.startswith(("your_", "your-", "my_", "my-"))
        or lowered in _placeholder_words()
    )


def _valid(validator: str | None, value: str) -> bool:
    if validator is None:
        return True
    if validator == "luhn_run":
        digits = _SEPARATORS.sub("", value)
        return digits.isdigit() and 13 <= len(digits) <= 19 and _luhn_ok(digits)
    if validator == "verhoeff":
        digits = _SEPARATORS.sub("", value)
        return (
            len(digits) == 12
            and digits.isdigit()
            and digits[0] not in "01"
            and _verhoeff_ok(digits)
        )
    if validator == "iban_mod97":
        return _iban_ok(value)
    if _is_reference(value):
        return False
    if validator == "password_value":
        return len(value) >= 4
    if validator == "token_value":
        mixed_case = any(char.islower() for char in value) and any(char.isupper() for char in value)
        return len(value) >= 8 and (bool(_DIGIT.search(value)) or mixed_case)
    if validator == "phrase_value":
        return len(value) >= 4 and bool(_DIGIT.search(value) or _NON_ALNUM.search(value))
    raise ValueError(f"secret_patterns_validator_unknown:{validator}")


def find_secret_spans(text: str | None) -> tuple[SecretSpan, ...]:
    """Every secret span in ``text``, earliest first, never overlapping.

    Overlaps resolve to the earliest start, then the longest span, then the
    pattern listed first in the contract (the more specific one). A span
    inside an existing ``⟦secret:...⟧`` placeholder is never reported.
    """
    source = str(text or "")
    if not source.strip():
        return ()
    protected = [(match.start(), match.end()) for match in _placeholder_token().finditer(source)]
    candidates: list[tuple[int, int, int, SecretPattern]] = []
    for order, pattern in enumerate(_patterns()):
        for match in pattern.regex.finditer(source):
            start, end = match.span(pattern.value_group)
            if start < 0 or end <= start:
                continue
            if any(start < p_end and end > p_start for p_start, p_end in protected):
                continue
            if not _valid(pattern.validator, source[start:end]):
                continue
            candidates.append((start, end, order, pattern))
    candidates.sort(key=lambda item: (item[0], -(item[1] - item[0]), item[2]))
    spans: list[SecretSpan] = []
    covered_until = -1
    for start, end, _order, pattern in candidates:
        if start < covered_until:
            continue
        spans.append(
            SecretSpan(
                start=start,
                end=end,
                kind=pattern.kind,
                pattern_id=pattern.pattern_id,
                file_to=pattern.file_to,
            )
        )
        covered_until = end
    return tuple(spans)


def first_secret_kind(text: str | None) -> str | None:
    """The kind of the first secret in ``text``, or None when it holds none."""
    spans = find_secret_spans(text)
    return spans[0].kind if spans else None


__all__ = ["SecretSpan", "find_secret_spans", "first_secret_kind"]
