"""Fail-closed validation of the scopes a semantic stage proposed for a question.

A paid answer starts as free text. Turning "what does your travel history say
about Japan?" into a scope set is a semantic judgement and belongs to the
resolver agent, not to this module: see
``consent-protocol/docs/reference/backend-semantic-boundary.md``. Keyword or
regex classification is explicitly forbidden there, and nothing here does any.

What this module does is the half that is explicitly permitted — an authority
guard. It only ever *removes* scopes:

* the accepted set is always a subset of what the agent proposed, so this can
  never decide an outcome the agent owns, and never widens what the owner is
  asked to approve;
* a scope the owner does not actually have is dropped, because the registry
  is per-owner and a resolver cannot invent one;
* a scope another person may never request is dropped via the single shared
  predicate ``is_scope_requestable_by_others`` (runtime secrets, credentials,
  keys, tokens, reserved and internal domains);
* every drop is returned with a reason, so a resolution that quietly collapses
  to nothing is visible rather than looking like a confident empty answer.

Pure and import-safe: no database, no network, so a pod can call it too.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Iterable, Mapping

from hushh_mcp.consent.pkm_scope_policy import normalize_pkm_scope
from hushh_mcp.consent.requestable_scope_policy import is_scope_requestable_by_others

# Matches the shape the request table stores and the catalogue emits.
_SCOPE_SHAPE = re.compile(r"^attr\.[a-z0-9_]+(\.[a-z0-9_*]+)*$")

# A resolver that proposes everything is not resolving. The owner reviews this
# list by hand, so it stays small enough to actually read.
MAX_RESOLVED_SCOPES = 12

DropReason = str

#: Why a proposed scope did not survive. Stable strings: they are recorded.
DROP_MALFORMED: DropReason = "malformed_scope"
DROP_NOT_REQUESTABLE: DropReason = "not_requestable_by_others"
DROP_NOT_IN_CATALOG: DropReason = "not_in_owner_catalog"
DROP_OVER_LIMIT: DropReason = "over_scope_limit"


@dataclass(frozen=True)
class ScopeResolution:
    """The outcome of validating one resolver proposal."""

    accepted: tuple[str, ...] = ()
    #: ``(scope, reason)`` for everything removed, in input order.
    dropped: tuple[tuple[str, DropReason], ...] = ()
    labels: Mapping[str, str] = field(default_factory=dict)

    @property
    def is_empty(self) -> bool:
        """True when nothing survived. The caller must not treat this as an answer."""
        return not self.accepted


def _canonical_scope(value: object) -> str | None:
    """Normalize to the stored ``attr.<domain>[.<path>]`` form, or None."""
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    if not text or not _SCOPE_SHAPE.match(text):
        return None
    domain, _path = normalize_pkm_scope(text)
    return text if domain else None


def validate_resolved_scopes(
    proposed: Iterable[object],
    *,
    owner_catalog: Iterable[object],
    catalog_labels: Mapping[str, str] | None = None,
    max_scopes: int = MAX_RESOLVED_SCOPES,
) -> ScopeResolution:
    """Filter a resolver's proposal down to what the owner may actually be asked.

    ``owner_catalog`` is the owner's own requestable scope entries, already read
    from ``pkm_scope_registry`` through the service that owns it. Passing an
    empty catalog yields an empty resolution, never a permissive one.

    The result's ``accepted`` is always a subset of ``proposed``: this function
    cannot introduce a scope, only remove one.
    """
    catalog: set[str] = set()
    for entry in owner_catalog or ():
        canonical = _canonical_scope(entry)
        if canonical:
            catalog.add(canonical)

    labels = {str(k).lower(): str(v) for k, v in (catalog_labels or {}).items()}

    accepted: list[str] = []
    dropped: list[tuple[str, DropReason]] = []
    seen: set[str] = set()

    for raw in proposed or ():
        original = str(raw or "").strip()
        canonical = _canonical_scope(raw)
        if not canonical:
            dropped.append((original, DROP_MALFORMED))
            continue
        if canonical in seen:
            continue
        seen.add(canonical)
        # Order matters only for the reason recorded; both checks are absolute.
        if not is_scope_requestable_by_others(canonical):
            dropped.append((canonical, DROP_NOT_REQUESTABLE))
            continue
        if canonical not in catalog:
            dropped.append((canonical, DROP_NOT_IN_CATALOG))
            continue
        if len(accepted) >= max_scopes:
            dropped.append((canonical, DROP_OVER_LIMIT))
            continue
        accepted.append(canonical)

    # Deterministic order so the terms digest is stable across resolutions.
    accepted.sort()
    return ScopeResolution(
        accepted=tuple(accepted),
        dropped=tuple(dropped),
        labels={scope: labels[scope] for scope in accepted if scope in labels},
    )


def canonical_question(question: str) -> str:
    """The question in the exact form the digest and the owner both see."""
    collapsed = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(question or ""))).strip()
    return collapsed


def compute_terms_digest(
    *,
    question: str,
    scopes: Iterable[str],
    owner_user_id: str,
    requester_user_id: str,
    amount_cents: int,
    currency: str = "usd",
) -> str:
    """Bind one payment to one question, scope set, pair of people and price.

    Any change to any of those produces a different digest, so a payment made
    against earlier terms cannot settle against the new ones. Canonical JSON
    with sorted keys and a sorted scope list keeps this reproducible on both
    sides of the checkout.
    """
    payload = {
        "amount_cents": int(amount_cents),
        "currency": str(currency or "").lower(),
        "owner_user_id": str(owner_user_id or ""),
        "question": canonical_question(question),
        "requester_user_id": str(requester_user_id or ""),
        "scopes": sorted({str(scope or "").strip().lower() for scope in scopes if scope}),
        "version": 1,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
