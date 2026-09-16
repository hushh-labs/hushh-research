"""Which stored keys are plumbing, and must never be offered as information.

The Memory route has filtered these since it was written -- `shouldSkipPkmMemoryKey`
in ``hushh-webapp/lib/pkm/pkm-memory-cards.ts`` -- and prunes whole subtrees so a
person browsing their own records never meets a schema version or a wizard
checkpoint. The consent catalogue applied nothing equivalent, in either language,
and so offered those same keys to anybody who asked for the person's information.

Measured 2026-09-11 against live UAT: asking for "finance information" about a
connected person returned 24 rows, roughly 5 of which were information about
anybody. A later capture of the same catalogue showed 50. The rest were
onboarding checkpoints and router telemetry.

Two near-misses, both worth remembering because both were nearly right:

* ``_STRUCTURAL_TOP_LEVEL_SCOPE_PATHS`` in ``scope_generator`` already knew
  ``domain_intent`` was structural. It only ever compared a DEPTH-1 segment, so
  ``financial.domain_intent`` was blocked while ``financial.profile.domain_intent.primary``
  walked straight through. Six of those reached one screen.
* ``_BLOCKED_EXTERNAL_PATH_PARTS`` in ``pkm_agent_lab_service`` runs at
  manifest-write time and holds ``created_at`` and ``updated_at`` -- which is why
  "Domain Intent Updated At" is absent from the capture and its three siblings
  are present. It has no ``selected_at``, ``anchor_at``, ``completed_at`` or
  ``skipped_at``.

The rules live in ``contracts/pkm/internal-path-keys.v1.json`` rather than here,
because the TypeScript predicate must agree with this one and two lists drift.
That is the same reason ``contracts/pkm/segment-humanization.v1.json`` exists.

This is deliberately a DENYLIST plus a shape test, not an allowlist. An allowlist
would be safer and is the wrong tool: the PKM's whole point is that a person's
records are open-ended, so anything unrecognised must be treated as theirs.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

_CONTRACT_PATH = (
    Path(__file__).resolve().parents[3] / "contracts" / "pkm" / "internal-path-keys.v1.json"
)

# Mirrors SECRET_KEY_PATTERN in pkm-memory-cards.ts. Kept in code rather than the
# contract because a regex in JSON is a regex nobody can read.
_SECRET_KEY_PATTERN = re.compile(
    r"(?:^|[_-])(secret|secrets|password|passphrase|token|api[_-]?key|private[_-]?key"
    r"|encryption[_-]?key|recovery[_-]?key|vault[_-]?key|credential|credentials"
    r"|authorization|mnemonic)(?:$|[_-])",
    re.IGNORECASE,
)

# The one `_id` that names a person rather than a record. The TypeScript
# predicate carves out exactly this, and the two must not disagree.
_PERSONAL_ID_KEYS = frozenset({"student_id"})


@lru_cache(maxsize=1)
def _contract() -> dict:
    with _CONTRACT_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


@lru_cache(maxsize=1)
def _internal_keys() -> frozenset[str]:
    return frozenset(str(key).strip().lower() for key in _contract()["internal_keys"])


@lru_cache(maxsize=1)
def _internal_suffixes() -> tuple[str, ...]:
    return tuple(str(s).strip().lower() for s in _contract()["internal_key_suffixes"])


@lru_cache(maxsize=1)
def _internal_branches() -> frozenset[str]:
    return frozenset(str(b).strip().lower() for b in _contract()["internal_branches"])


def _normalize(segment: str) -> str:
    return str(segment or "").strip().lower()


def is_internal_path_segment(segment: str) -> bool:
    """True when one path segment is plumbing rather than a person's record."""
    raw = str(segment or "").strip()
    # Checked on the RAW segment: normalisation strips underscores, so a
    # leading-underscore key would be unmasked by the very step meant to clean it.
    if raw.startswith("_"):
        return True

    normalized = _normalize(raw)
    if not normalized:
        return True
    if normalized in _internal_keys() or normalized in _internal_branches():
        return True
    if _SECRET_KEY_PATTERN.search(normalized):
        return True
    if normalized.endswith("_id") and normalized not in _PERSONAL_ID_KEYS:
        return True
    if "cipher" in normalized or "token" in normalized:
        return True
    return any(normalized.endswith(suffix) for suffix in _internal_suffixes())


def is_internal_manifest_path(path: str) -> bool:
    """True when ANY segment of a dotted path is plumbing.

    Any segment, at any depth. That is the whole correction: the filter this
    replaces looked only at the first segment, so nesting a structural key one
    level down was enough to publish it.
    """
    return any(is_internal_path_segment(segment) for segment in str(path or "").split("."))
