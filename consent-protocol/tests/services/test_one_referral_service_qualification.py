"""Regression coverage for onboarding-driven referral qualification.

The qualification pipeline used to require fifteen minutes of credited active
time inside an eligible agent, plus a minimum-event count, before a referral
could move past `signed_up` -- and nothing ever drove it there in practice,
so every referral sat at "In progress" forever. `sync_referral_qualification_from_onboarding`
is the fix: it is the one function that reacts to a referred user finishing
the required Hushh One onboarding flow (`vault_keys.setup_completed`) and a
server-verified phone (`actor_identity_cache.phone_verified`), and it is the
only place a relationship advances past `signed_up`.

These tests pin the product rule directly: onboarding completion is the whole
bar, nothing about engagement gates it, and the whole thing is idempotent.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from hushh_mcp.services import one_referral_service

RELATIONSHIP_ID = "22222222-2222-2222-2222-222222222222"
REFERRED_USER = "user_referred_b"
NOW_MS = int(datetime(2026, 8, 25, tzinfo=timezone.utc).timestamp() * 1000)


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _Relationship:
    def __init__(self, status: str):
        self.id = RELATIONSHIP_ID
        self.status = status
        self.signed_up_at = None
        self.phone_verified_at = None
        self.onboarded_at = None
        self.engagement_started_at = None
        self.qualified_at = None
        self.rejected_at = None
        self.expired_at = None


def _policy_row():
    return SimpleNamespace(
        version=1,
        program_enabled=True,
        new_users_only=True,
        attribution_window_days=30,
        qualification_window_days=7,
        required_active_seconds=900,
        minimum_meaningful_events=3,
        eligible_agent_keys=(),
        heartbeat_interval_seconds=30,
        max_credit_per_heartbeat_secs=30,
        recent_interaction_window_secs=60,
        max_reporting_gap_seconds=90,
    )


def _harness(
    *,
    relationship: _Relationship | None,
    setup_completed: bool,
    setup_completed_at: int | None,
    phone_verified: bool,
    vault_row_exists: bool = True,
    identity_row_exists: bool = True,
):
    vault_row = (
        SimpleNamespace(setup_completed=setup_completed, setup_completed_at=setup_completed_at)
        if vault_row_exists
        else None
    )
    identity_row = SimpleNamespace(phone_verified=phone_verified) if identity_row_exists else None

    def execute(query, params=None):
        sql = str(query)
        params = params or {}
        if "one_referral_policies" in sql:
            return _Result([_policy_row()])
        if "SELECT id, status" in sql and "one_referral_relationships" in sql:
            if relationship is None:
                return _Result([])
            return _Result([SimpleNamespace(id=relationship.id, status=relationship.status)])
        if "FROM vault_keys" in sql:
            return _Result([vault_row] if vault_row is not None else [])
        if "FROM actor_identity_cache" in sql:
            return _Result([identity_row] if identity_row is not None else [])
        if "UPDATE one_referral_relationships" in sql:
            assert relationship is not None
            if "'signed_up'" in sql:
                relationship.status = "signed_up"
                relationship.signed_up_at = params["ts"]
            elif "'phone_verified'" in sql:
                relationship.status = "phone_verified"
                relationship.phone_verified_at = params["ts"]
            elif "'onboarded'" in sql:
                relationship.status = "onboarded"
                relationship.onboarded_at = params["ts"]
            elif "'engaging'" in sql:
                relationship.status = "engaging"
                relationship.engagement_started_at = params["ts"]
            elif "'qualified'" in sql:
                relationship.status = "qualified"
                relationship.qualified_at = params["ts"]
            elif "'under_review'" in sql:
                relationship.status = "under_review"
            elif "'rejected'" in sql:
                relationship.status = "rejected"
                relationship.rejected_at = params["ts"]
            elif "'expired'" in sql:
                relationship.status = "expired"
                relationship.expired_at = params["ts"]
            else:
                raise AssertionError(f"unrecognized transition: {sql}")
            return _Result([])
        raise AssertionError(f"unexpected query: {sql}")

    conn = MagicMock()
    conn.execute.side_effect = execute
    return conn


@contextmanager
def _db(conn):
    yield conn


def _run(conn):
    with patch.object(one_referral_service, "get_db_connection", side_effect=lambda: _db(conn)):
        return one_referral_service.sync_referral_qualification_from_onboarding(REFERRED_USER)


# --- the new funnel: onboarding completion is the whole bar ------------------


def test_a_new_referral_qualifies_the_moment_onboarding_completes():
    relationship = _Relationship("signed_up")
    conn = _harness(
        relationship=relationship,
        setup_completed=True,
        setup_completed_at=NOW_MS,
        phone_verified=True,
    )

    result = _run(conn)

    assert result == {"status": "updated", "relationship_status": "qualified"}
    assert relationship.status == "qualified"
    assert relationship.qualified_at is not None


def test_zero_credited_active_seconds_does_not_block_qualification():
    # The old bar was 900 seconds of credited engagement. This user has none --
    # no engagement session was ever created for them -- and still qualifies.
    relationship = _Relationship("signed_up")
    conn = _harness(
        relationship=relationship,
        setup_completed=True,
        setup_completed_at=NOW_MS,
        phone_verified=True,
    )

    result = _run(conn)

    assert result["relationship_status"] == "qualified"


def test_never_having_used_an_eligible_agent_does_not_block_qualification():
    # No one_agent_engagement_sessions row for one_location, hushh_research, or
    # hushh_research_pkm was ever created for this user; the sync function
    # never even looks at that table.
    relationship = _Relationship("onboarded")
    conn = _harness(
        relationship=relationship,
        setup_completed=True,
        setup_completed_at=NOW_MS,
        phone_verified=True,
    )

    result = _run(conn)

    assert result["relationship_status"] == "qualified"


def test_zero_meaningful_events_does_not_block_qualification():
    relationship = _Relationship("phone_verified")
    conn = _harness(
        relationship=relationship,
        setup_completed=True,
        setup_completed_at=NOW_MS,
        phone_verified=True,
    )

    result = _run(conn)

    assert result["relationship_status"] == "qualified"


def test_onboarding_incomplete_leaves_the_relationship_in_progress():
    relationship = _Relationship("signed_up")
    conn = _harness(
        relationship=relationship,
        setup_completed=False,
        setup_completed_at=None,
        phone_verified=True,
    )

    result = _run(conn)

    assert result["status"] == "no_change"
    assert relationship.status == "signed_up"


def test_an_unverified_phone_leaves_the_relationship_in_progress():
    relationship = _Relationship("signed_up")
    conn = _harness(
        relationship=relationship,
        setup_completed=True,
        setup_completed_at=NOW_MS,
        phone_verified=False,
    )

    result = _run(conn)

    assert result["status"] == "no_change"
    assert relationship.status == "signed_up"


# --- idempotency and settled states ------------------------------------------


def test_sending_onboarding_completed_twice_does_not_duplicate_or_corrupt():
    relationship = _Relationship("signed_up")
    conn = _harness(
        relationship=relationship,
        setup_completed=True,
        setup_completed_at=NOW_MS,
        phone_verified=True,
    )

    first = _run(conn)
    qualified_at_after_first = relationship.qualified_at
    second = _run(conn)

    assert first == {"status": "updated", "relationship_status": "qualified"}
    assert second == {"status": "no_change", "relationship_status": "qualified"}
    assert relationship.status == "qualified"
    assert relationship.qualified_at == qualified_at_after_first


def test_an_already_qualified_referral_stays_qualified():
    relationship = _Relationship("qualified")
    relationship.qualified_at = NOW_MS
    conn = _harness(
        relationship=relationship,
        setup_completed=True,
        setup_completed_at=NOW_MS,
        phone_verified=True,
    )

    result = _run(conn)

    assert result == {"status": "no_change", "relationship_status": "qualified"}
    assert relationship.status == "qualified"


def test_a_revoked_referral_is_never_resurrected():
    relationship = _Relationship("revoked")
    conn = _harness(
        relationship=relationship,
        setup_completed=True,
        setup_completed_at=NOW_MS,
        phone_verified=True,
    )

    result = _run(conn)

    assert result == {"status": "no_change", "relationship_status": "revoked"}
    assert relationship.status == "revoked"


def test_someone_who_was_never_referred_is_a_safe_no_op():
    conn = _harness(
        relationship=None,
        setup_completed=True,
        setup_completed_at=NOW_MS,
        phone_verified=True,
    )

    result = _run(conn)

    assert result == {"status": "not_referred"}
