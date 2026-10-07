"""The signed consent revocation list a person's own agent checks tokens against.

WHY. An Ed25519 consent token proves who issued it, never whether it is still good:
the revoked set lives in the hub's database. A pod used to ask the hub about every
token. For an agent in the person's own cloud the hub instead hands the pod a list,
signed under the ``OWNER_FEED`` namespace, of every still-unexpired token of this
owner that is no longer live (revoked, denied after, or superseded by a newer grant),
plus every token that IS live, and the pod checks locally. A token must be in
``live`` and absent from ``revoked``: the hub's ``is_token_active`` is an allow list
(a token with no committed grant head is refused), so the pod's check is too.

THE CONTRACT (``pod_consent_revocation_v1``)::

    {"list": {"kind", "ownerId", "hushhId", "environment", "podKeyId",
              "incarnationEpoch", "issuedAtMs",
              "revoked": [sha256 hex], "live": [sha256 hex]},
     "signature": "ed25519.<kid>.<b64url>"}

The signature covers ``canonical_json(list)``. The pod accepts a list only for its
own HusshID, never older than the one it holds (a replayed older list could un-revoke
a token), and treats it as authoritative for ``MAX_AGE_MS`` only. Past that the
local check answers ``unavailable``: it fails closed, never open.

The hub half (:func:`build_consent_revocation_list`) is delivered with the heartbeat
response; the pod half (:func:`install_revocation_list`) runs on the beat.
"""

from __future__ import annotations

import hashlib
import re
import threading
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Optional

from hushh_mcp.consent.token_signing import OWNER_FEED, sign_payload, verify_payload
from hushh_mcp.services.pod_session_authority import canonical_json

KIND = "pod_consent_revocation_v1"
#: How long a list stays authoritative. Heartbeats run every 60 seconds, so this
#: tolerates several missed beats before every local consent check fails closed.
MAX_AGE_MS = 10 * 60 * 1000
#: How far ahead of the pod's clock a list may claim to be issued.
MAX_FUTURE_SKEW_MS = 2 * 60 * 1000
MAX_ENTRIES = 5000

_FINGERPRINT_RE = re.compile(r"^[0-9a-f]{64}$")
_BINDING_KEYS = frozenset({"hushhId", "environment", "podKeyId", "incarnationEpoch"})
_LIST_KEYS = frozenset({"kind", "ownerId", "issuedAtMs", "revoked", "live"}) | _BINDING_KEYS


class RevocationListRefused(ValueError):
    """A list this pod will not install. ``code`` is the whole explanation."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class RevocationBinding:
    """The serving key and claimed owner-log incarnation, never caller identity."""

    hushh_id: str
    environment: str
    pod_key_id: str
    incarnation_epoch: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "hushhId": self.hushh_id,
            "environment": self.environment,
            "podKeyId": self.pod_key_id,
            "incarnationEpoch": self.incarnation_epoch,
        }

    @classmethod
    def from_mapping(cls, raw: Any) -> "RevocationBinding":
        if not isinstance(raw, Mapping) or set(raw) != _BINDING_KEYS:
            raise RevocationListRefused("BAD_BINDING")
        for name in ("hushhId", "environment", "podKeyId"):
            value = raw.get(name)
            if not isinstance(value, str) or not value.strip() or len(value) > 256:
                raise RevocationListRefused("BAD_BINDING")
            if value != value.strip():
                raise RevocationListRefused("BAD_BINDING")
        epoch = raw.get("incarnationEpoch")
        if type(epoch) is not int or not 1 <= epoch <= 2**63 - 1:
            raise RevocationListRefused("BAD_BINDING")
        return cls(raw["hushhId"], raw["environment"], raw["podKeyId"], epoch)


def current_revocation_binding() -> RevocationBinding:
    """Exact local authority; the heartbeat also checks its live lease before use."""
    from hushh_mcp.services.pod_session_authority import active_session_authority

    authority = active_session_authority()
    if authority is None:
        raise RevocationListRefused("NO_INCARNATION_AUTHORITY")
    return RevocationBinding.from_mapping(
        {
            "hushhId": authority.hushh_id,
            "environment": authority.environment,
            "podKeyId": authority.pod_key_id,
            "incarnationEpoch": authority.epoch,
        }
    )


@dataclass(frozen=True)
class RevocationList:
    owner_id: str
    hushh_id: str
    issued_at_ms: int
    revoked: frozenset[str]
    live: frozenset[str]
    binding: RevocationBinding

    def fresh(self, now_ms: int) -> bool:
        return -MAX_FUTURE_SKEW_MS <= now_ms - self.issued_at_ms <= MAX_AGE_MS


def token_fingerprint(token: str) -> str:
    return hashlib.sha256(str(token).encode("utf-8")).hexdigest()


def _now_ms() -> int:
    return int(time.time() * 1000)


# -- hub half ---------------------------------------------------------------------


def sign_revocation_list(
    *,
    owner_id: str,
    hushh_id: str,
    revoked: Iterable[str],
    issued_at_ms: int,
    live: Iterable[str] = (),
    binding: RevocationBinding,
) -> dict[str, Any]:
    """Sign one list. Raises when the hub holds no ``OWNER_FEED`` private key."""
    binding = RevocationBinding.from_mapping(binding.to_dict())
    if binding.hushh_id != hushh_id:
        raise RevocationListRefused("WRONG_POD")
    body = {
        "kind": KIND,
        "ownerId": owner_id,
        **binding.to_dict(),
        "issuedAtMs": int(issued_at_ms),
        "revoked": sorted(set(revoked)),
        "live": sorted(set(live)),
    }
    if len(body["revoked"]) > MAX_ENTRIES or len(body["live"]) > MAX_ENTRIES:
        raise RuntimeError("consent revocation list exceeds its bound")
    signature = sign_payload(
        canonical_json(body), hmac_key="", namespace=OWNER_FEED, require_asymmetric=True
    )
    return {"list": body, "signature": signature}


def revoked_fingerprints(
    latest: Iterable[Mapping[str, Any]], live_grants: Iterable[Mapping[str, Any]]
) -> set[str]:
    """Every unexpired granted token whose (agent, scope) lineage no longer names it."""
    return split_fingerprints(latest, live_grants)[0]


def split_fingerprints(
    latest: Iterable[Mapping[str, Any]], live_grants: Iterable[Mapping[str, Any]]
) -> tuple[set[str], set[str]]:
    """``(revoked, live)`` fingerprints of every unexpired grant.

    ``latest`` is the newest consent event per (agent_id, scope); ``live_grants`` is
    every unexpired grant. A grant is live only while the newest event for its pair
    is that very grant, which is the hub's own ``is_token_active`` rule.
    """
    current = {(str(row.get("agent_id") or ""), str(row.get("scope") or "")): row for row in latest}
    revoked: set[str] = set()
    live: set[str] = set()
    for grant in live_grants:
        token_id = str(grant.get("token_id") or "")
        if not token_id:
            continue
        head = current.get((str(grant.get("agent_id") or ""), str(grant.get("scope") or "")))
        if (
            head is None
            or head.get("action") != "CONSENT_GRANTED"
            or str(head.get("token_id") or "") != token_id
        ):
            revoked.add(token_fingerprint(token_id))
        else:
            live.add(token_fingerprint(token_id))
    return revoked, live


_LATEST_SQL = (
    "SELECT DISTINCT ON (agent_id, scope) agent_id, scope, action, token_id "
    "FROM consent_audit WHERE user_id = :user_id "
    # A denial breaks lineage only for personal_agent, as in is_token_active.
    "AND (action IN ('CONSENT_GRANTED', 'REVOKED') "
    "OR (action = 'CONSENT_DENIED' AND agent_id = 'personal_agent')) "
    "ORDER BY agent_id, scope, issued_at DESC, id DESC"
)
_LIVE_GRANTS_SQL = (
    "SELECT agent_id, scope, token_id FROM consent_audit WHERE user_id = :user_id "
    "AND action = 'CONSENT_GRANTED' AND token_id IS NOT NULL "
    "AND (expires_at IS NULL OR expires_at > :now_ms) LIMIT :limit"
)


def _read_consent_rows(owner_user_id: str, now_ms: int) -> tuple[list[dict], list[dict]]:
    from db.db_client import get_db  # noqa: PLC0415 - hub only; a pod has no database

    db = get_db()
    latest = db.execute_raw(_LATEST_SQL, {"user_id": owner_user_id}).data or []
    grants = (
        db.execute_raw(
            _LIVE_GRANTS_SQL,
            {"user_id": owner_user_id, "now_ms": now_ms, "limit": MAX_ENTRIES + 1},
        ).data
        or []
    )
    return list(latest), list(grants)


async def build_consent_revocation_list(
    owner_user_id: str,
    hushh_id: str,
    *,
    binding: RevocationBinding,
    reader: Any = None,
    now_ms: Optional[int] = None,
) -> dict[str, Any]:
    """The hub's signed list for one owner's pod. Raises rather than truncating.

    A list cut short would silently un-revoke whatever was cut, so an oversize or
    unreadable ledger raises; the beat then carries no list, the pod's copy ages
    out, and its local checks fail closed.
    """
    import asyncio  # noqa: PLC0415

    if not owner_user_id or not hushh_id:
        raise ValueError("revocation list needs an owner and a HusshID")
    issued = _now_ms() if now_ms is None else int(now_ms)
    latest, grants = await asyncio.to_thread(reader or _read_consent_rows, owner_user_id, issued)
    if len(grants) > MAX_ENTRIES:
        raise RuntimeError("consent ledger exceeds the revocation list bound")
    revoked, live = split_fingerprints(latest, grants)
    return sign_revocation_list(
        owner_id=owner_user_id,
        hushh_id=hushh_id,
        binding=binding,
        revoked=revoked,
        live=live,
        issued_at_ms=issued,
    )


# -- pod half ---------------------------------------------------------------------


def verify_revocation_list(doc: Any, *, binding: RevocationBinding, now_ms: int) -> RevocationList:
    """Check one list against THIS pod. Raises ``RevocationListRefused``."""
    if not isinstance(doc, Mapping) or set(doc) != {"list", "signature"}:
        raise RevocationListRefused("BAD_LIST")
    body, signature = doc.get("list"), doc.get("signature")
    if not isinstance(body, Mapping) or set(body) != _LIST_KEYS or not isinstance(signature, str):
        raise RevocationListRefused("BAD_LIST")
    if not verify_payload(
        canonical_json(body),
        signature,
        hmac_key="",
        namespace=OWNER_FEED,
        require_asymmetric=True,
    ):
        raise RevocationListRefused("BAD_SIGNATURE")
    supplied_binding = RevocationBinding.from_mapping({key: body[key] for key in _BINDING_KEYS})
    if body.get("kind") != KIND or supplied_binding.hushh_id != binding.hushh_id:
        raise RevocationListRefused("WRONG_POD")
    if supplied_binding != binding:
        raise RevocationListRefused("WRONG_INCARNATION")
    owner_id, issued = body.get("ownerId"), body.get("issuedAtMs")
    if not isinstance(owner_id, str) or not owner_id:
        raise RevocationListRefused("BAD_LIST")
    if type(issued) is not int or not 0 <= issued <= now_ms + MAX_FUTURE_SKEW_MS:
        raise RevocationListRefused("BAD_TIME")
    revoked, live = _fingerprint_set(body.get("revoked")), _fingerprint_set(body.get("live"))
    return RevocationList(owner_id, binding.hushh_id, issued, revoked, live, binding)


def _fingerprint_set(items: Any) -> frozenset[str]:
    if (
        not isinstance(items, list)
        or len(items) > MAX_ENTRIES
        or not all(isinstance(item, str) and _FINGERPRINT_RE.fullmatch(item) for item in items)
    ):
        raise RevocationListRefused("BAD_LIST")
    return frozenset(items)


_LOCK = threading.Lock()
_INSTALLED: Optional[RevocationList] = None
_CONFLICTED = False


def install_revocation_list(doc: Any, *, now_ms: Optional[int] = None) -> bool:
    """Verify and hold a list from the heartbeat. Never installs an older one.

    Returns True when this list replaced the held one. Raises
    ``RevocationListRefused`` for a list that does not verify for this pod.
    """
    global _INSTALLED, _CONFLICTED
    now = _now_ms() if now_ms is None else int(now_ms)
    binding = current_revocation_binding()
    verified = verify_revocation_list(doc, binding=binding, now_ms=now)
    with _LOCK:
        if current_revocation_binding() != binding:
            raise RevocationListRefused("WRONG_INCARNATION")
        held = _INSTALLED
        if (
            held is not None
            and held.binding == binding
            and verified.issued_at_ms <= held.issued_at_ms
        ):
            if verified.issued_at_ms == held.issued_at_ms and verified != held:
                # Preserve the replay high-water while refusing either side of
                # signed equivocation. A strictly newer snapshot can recover.
                _CONFLICTED = True
                raise RevocationListRefused("CONFLICTING_REPLAY")
            return False
        _INSTALLED = verified
        _CONFLICTED = False
        return True


def installed_revocation_list() -> Optional[RevocationList]:
    with _LOCK:
        held = None if _CONFLICTED else _INSTALLED
    if held is None:
        return None
    try:
        return held if held.binding == current_revocation_binding() else None
    except RevocationListRefused:
        return None


def clear_installed_revocation_list() -> None:
    """Test and erasure hook."""
    global _INSTALLED, _CONFLICTED
    with _LOCK:
        _INSTALLED = None
        _CONFLICTED = False


__all__ = [
    "KIND",
    "MAX_AGE_MS",
    "RevocationList",
    "RevocationBinding",
    "RevocationListRefused",
    "build_consent_revocation_list",
    "clear_installed_revocation_list",
    "current_revocation_binding",
    "install_revocation_list",
    "installed_revocation_list",
    "revoked_fingerprints",
    "sign_revocation_list",
    "split_fingerprints",
    "token_fingerprint",
    "verify_revocation_list",
]
