"""Consent + scoped-sharing interactions for the multi-pod simulation.

Every consent operation here goes through the **real** protocol —
``issue_token`` / ``validate_token`` / ``revoke_token`` and
``ConsentScope.check_access`` — not a stand-in. A simulation that hand-rolls
consent proves that the harness agrees with itself.

**Canonical scopes only.** Scope strings are built as ``attr.{domain}.{path}.*``
and the reserved values come from ``ConsentScope``. A simulation that invents a
scope string would produce a green run and a scope-authority drift, which is the
exact failure the PKM-upgrade-rehearsal lane names.

**The log is metadata only.** A consent-log entry records *that* an access was
attempted, by whom, under which scope, and how it was decided. There is nowhere
in ``ConsentLogEntry`` to put a value, so leaking content would take a schema
change rather than a slip. This is the founder constraint on the real ledger and
the reason the entry is a frozen dataclass with named fields instead of a dict.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from typing import Any, Optional

from hushh_mcp.consent.token import (
    issue_token,
    revoke_token,
    validate_token,
)
from hushh_mcp.constants import ConsentScope

# The domains a simulated user's PKM can carry. Each pod loads a different slice,
# so the fleet is heterogeneous rather than 50 copies of one fixture.
DOMAIN_CATALOG: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("financial", ("portfolio", "holdings", "profile")),
    ("food", ("preferences", "allergies", "orders")),
    ("travel", ("trips", "loyalty", "preferences")),
    ("health", ("activity", "vitals")),
    ("shopping", ("orders", "wishlist")),
)

# Actions the OWNER sees in their log. Named to match the pod-access ledger the
# hub already writes, so the simulation and the product speak one vocabulary.
ACTION_GRANTED = "CONSENT_GRANTED"
ACTION_REVOKED = "CONSENT_REVOKED"
ACTION_ACCESS_ALLOWED = "POD_ACCESS_ALLOWED"
ACTION_ACCESS_DENIED = "POD_ACCESS_DENIED"


@dataclass(frozen=True)
class ConsentLogEntry:
    """One line of the log the 🤫 One user sees. Metadata only, by construction."""

    at_ms: int
    owner_hushh_id: str
    counterparty: str  # the agent id the grant is bound to, e.g. investor:<user>
    scope: str  # canonical scope string, verbatim
    action: str
    reason: Optional[str] = None  # why a denial happened; never what was denied

    def to_row(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ConsentLedger:
    """The user-visible consent log, partitioned by owner.

    Partitioning matters: a user's log is *their* log. Reading it back per owner
    is what lets the simulation assert that no user's log ever names another
    user's records.
    """

    entries: list[ConsentLogEntry] = field(default_factory=list)

    def record(
        self,
        *,
        owner: str,
        counterparty: str,
        scope: str,
        action: str,
        reason: Optional[str] = None,
    ) -> ConsentLogEntry:
        entry = ConsentLogEntry(
            at_ms=int(time.time() * 1000),
            owner_hushh_id=owner,
            counterparty=counterparty,
            scope=scope,
            action=action,
            reason=reason,
        )
        self.entries.append(entry)
        return entry

    def for_owner(self, owner: str) -> list[ConsentLogEntry]:
        return [e for e in self.entries if e.owner_hushh_id == owner]

    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for entry in self.entries:
            out[entry.action] = out.get(entry.action, 0) + 1
        return out


def domains_for(index: int, how_many: int = 2) -> list[tuple[str, tuple[str, ...]]]:
    """A per-pod slice of the catalogue, so PKM shape varies across the fleet."""
    start = index % len(DOMAIN_CATALOG)
    return [DOMAIN_CATALOG[(start + i) % len(DOMAIN_CATALOG)] for i in range(how_many)]


def scope_for(domain: str, path: str) -> str:
    """The canonical dynamic scope string. Built, never invented."""
    return f"attr.{domain}.{path}.*"


def counterparty_id(user_id: str) -> str:
    """How a counterpart USER is encoded in a grant.

    There is no second-user principal in a consent token: the counterpart is
    carried in ``agent_id`` as ``investor:<user_id>`` / ``ria:<profile_id>``.
    That is the real user-to-user mechanism, so the simulation uses it rather
    than inventing a recipient field.
    """
    return f"investor:{user_id}"


def run_consent_round(
    *,
    owner_hushh_id: str,
    owner_user_id: str,
    recipient_user_id: str,
    domain: str,
    path: str,
    other_domain: str,
    ledger: ConsentLedger,
) -> list[tuple[str, bool, str]]:
    """One full consent lifecycle between two users. Returns (check, ok, detail).

    Grant -> use -> attempt out-of-scope -> attempt widening -> revoke -> re-use.
    Every step lands a log line, including every denial: a refusal that leaves no
    trace is indistinguishable from an attempt that never happened.
    """
    results: list[tuple[str, bool, str]] = []
    granted_scope = scope_for(domain, path)
    agent_id = counterparty_id(recipient_user_id)

    # 1. GRANT -- a real signed token bound to (owner, counterparty, scope).
    token = issue_token(owner_user_id, agent_id, granted_scope)
    ledger.record(
        owner=owner_hushh_id, counterparty=agent_id, scope=granted_scope, action=ACTION_GRANTED
    )

    # 2. USE within scope -- must validate.
    valid, reason, obj = validate_token(token.token, expected_scope=granted_scope)
    ledger.record(
        owner=owner_hushh_id,
        counterparty=agent_id,
        scope=granted_scope,
        action=ACTION_ACCESS_ALLOWED if valid else ACTION_ACCESS_DENIED,
        reason=None if valid else reason,
    )
    results.append(("consent_in_scope_allows", bool(valid), reason or "valid"))
    if valid and obj is not None and getattr(obj, "user_id", None) != owner_user_id:
        results.append(("consent_token_binds_owner", False, "token user_id is not the owner"))
    else:
        results.append(("consent_token_binds_owner", True, "bound"))

    # 3. USE outside scope -- a token for one domain must not open another.
    foreign_scope = scope_for(other_domain, "preferences")
    ok_foreign, foreign_reason, _ = validate_token(token.token, expected_scope=foreign_scope)
    ledger.record(
        owner=owner_hushh_id,
        counterparty=agent_id,
        scope=foreign_scope,
        action=ACTION_ACCESS_DENIED if not ok_foreign else ACTION_ACCESS_ALLOWED,
        reason=foreign_reason if not ok_foreign else None,
    )
    results.append(
        (
            "consent_cross_domain_denied",
            not ok_foreign,
            "refused" if not ok_foreign else "CROSS-DOMAIN TOKEN ACCEPTED",
        )
    )

    # 4. WIDENING -- holding a narrow grant must never imply the whole PKM.
    # pkm.read matches every attr.* scope, so this is the direction that matters.
    widened = ConsentScope.check_access(ConsentScope.PKM_READ.value, [granted_scope])
    results.append(
        (
            "consent_no_scope_widening",
            not widened,
            "narrow grant stays narrow" if not widened else "NARROW GRANT WIDENED TO pkm.read",
        )
    )

    # 5. REVOKE -- and prove the same token stops working.
    revoke_token(token.token)
    ledger.record(
        owner=owner_hushh_id,
        counterparty=agent_id,
        scope=granted_scope,
        action=ACTION_REVOKED,
    )
    after, after_reason, _ = validate_token(token.token, expected_scope=granted_scope)
    ledger.record(
        owner=owner_hushh_id,
        counterparty=agent_id,
        scope=granted_scope,
        action=ACTION_ACCESS_DENIED if not after else ACTION_ACCESS_ALLOWED,
        reason=after_reason if not after else None,
    )
    results.append(
        (
            "consent_revocation_is_immediate",
            not after,
            after_reason or ("REVOKED TOKEN STILL VALID" if after else "revoked"),
        )
    )

    # 6. EXPIRY -- an expired grant leaks nothing, checked before scope.
    short = issue_token(owner_user_id, agent_id, granted_scope, expires_in_ms=1)
    time.sleep(0.005)
    expired_ok, expired_reason, _ = validate_token(short.token, expected_scope=granted_scope)
    results.append(
        (
            "consent_expiry_refuses",
            not expired_ok,
            expired_reason or ("EXPIRED TOKEN ACCEPTED" if expired_ok else "expired"),
        )
    )
    return results


def _status_for(action: str) -> str:
    """The status string the API emits, mirroring ``_map_action_to_status``.

    Unmapped actions fall through to ``action.lower()`` -- which is exactly why
    ``POD_ACCESS_ALLOWED`` reaches the user as the raw protocol identifier.
    """
    mapping = {
        "REQUESTED": "request_pending",
        "CONSENT_GRANTED": "approved",
        "CONSENT_DENIED": "denied",
        "REVOKED": "revoked",
        "CANCELLED": "cancelled",
        "TIMEOUT": "expired",
        "READ": "read",
    }
    return mapping.get(action, action.lower() or "unknown")


def group_for_ui(ledger: ConsentLedger, owner: str) -> list[dict[str, Any]]:
    """Regroup a flat log into the shape the History tab actually renders.

    The consent centre does NOT render a flat activity feed. It renders a
    three-level tree -- identifier row -> lifecycle trails -> events -- keyed by
    ``{counterpart_type}|{counterpart_id}|{subject}``, every level sorted
    ``issued_at`` descending. Emitting flat rows would produce a fixture the real
    UI cannot consume, so the simulation groups the same way the service does.
    """
    by_identifier: dict[str, list[ConsentLogEntry]] = {}
    for entry in ledger.for_owner(owner):
        # The counterparty is `investor:<user_id>`; type and id split on the colon.
        kind, _, ident = entry.counterparty.partition(":")
        key = f"{kind}|{ident}|current_user".lower()
        by_identifier.setdefault(key, []).append(entry)

    rows: list[dict[str, Any]] = []
    for key, entries in by_identifier.items():
        ordered = sorted(entries, key=lambda e: e.at_ms, reverse=True)
        trails: dict[str, list[ConsentLogEntry]] = {}
        for entry in ordered:
            trails.setdefault(f"{key}|{entry.scope}", []).append(entry)
        newest = ordered[0]
        rows.append(
            {
                "id": f"identifier:{key}",
                "kind": "history",
                "identifier_key": key,
                "identifier_label": newest.counterparty,
                "status": _status_for(newest.action),
                "action": newest.action,
                "scope": newest.scope,
                "normalized_scope": newest.scope,
                "issued_at": newest.at_ms,
                "trail_count": len(trails),
                "event_count": len(ordered),
                "consent_trails": [
                    {
                        "id": f"trail:{trail_key}",
                        "trail_key": trail_key,
                        "scope": items[0].scope,
                        "normalized_scope": items[0].scope,
                        "status": _status_for(items[0].action),
                        "action": items[0].action,
                        "issued_at": items[0].at_ms,
                        "event_count": len(items),
                        "events": [
                            {
                                "id": f"{e.owner_hushh_id}-{e.at_ms}-{idx}",
                                "status": _status_for(e.action),
                                "action": e.action,
                                "issued_at": e.at_ms,
                                "scope": e.scope,
                                "scope_description": None,
                            }
                            for idx, e in enumerate(items)
                        ],
                    }
                    for trail_key, items in trails.items()
                ],
            }
        )
    return sorted(rows, key=lambda r: r["issued_at"], reverse=True)


def log_carries_no_content(ledger: ConsentLedger) -> tuple[bool, str]:
    """No log line may carry record content. The ledger records that, never what."""
    banned = ("cipher", "ciphertext", "segment", "payload", "summary", "blob", "value")
    for entry in ledger.entries:
        blob = " ".join(str(v).lower() for v in entry.to_row().values())
        for token_name in banned:
            if token_name in blob:
                return False, f"consent log entry carries {token_name!r}"
    return True, f"entries={len(ledger.entries)}"


def log_is_owner_partitioned(ledger: ConsentLedger, owners: list[str]) -> tuple[bool, str]:
    """Every entry belongs to exactly one owner, and reading one owner's log
    never returns another's."""
    known = set(owners)
    for entry in ledger.entries:
        if entry.owner_hushh_id not in known:
            return False, f"entry for unknown owner {entry.owner_hushh_id!r}"
    for owner in owners:
        for entry in ledger.for_owner(owner):
            if entry.owner_hushh_id != owner:
                return False, f"{owner}'s log returned an entry owned by {entry.owner_hushh_id}"
    return True, f"owners={len(owners)}"
