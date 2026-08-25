"""Regression coverage for the referral integrity checks `bind_attribution` enforces.

These are unrelated to the qualification-pipeline fix in
`sync_referral_qualification_from_onboarding`, but the same change request
calls out that qualifying on onboarding completion must never come at the
cost of weakening attribution integrity. These pin the two checks that were
otherwise untested at the Python level (the migration test suite pins the
database constraints; this pins the service branches that return before a
constraint would ever be reached).
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from hushh_mcp.services import one_referral_service

ATTRIBUTION_ID = "11111111-1111-1111-1111-111111111111"
NOW = datetime(2026, 8, 25, tzinfo=timezone.utc)


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


def _pending_attribution(referrer_user_id: str, *, first_seen_at=None):
    return SimpleNamespace(
        id=ATTRIBUTION_ID,
        referrer_user_id=referrer_user_id,
        policy_version=1,
        status="pending",
        expires_at=NOW + timedelta(days=30),
        first_seen_at=first_seen_at or (NOW - timedelta(days=1)),
    )


def _policy_row(*, new_users_only: bool = True):
    return SimpleNamespace(
        version=1,
        program_enabled=True,
        new_users_only=new_users_only,
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


def _harness(*, attribution, existing_relationship: bool, predates_attribution: bool):
    def execute(query, params=None):
        sql = str(query)
        if "FROM one_referral_attributions" in sql and "SELECT id, referrer_user_id" in sql:
            return _Result([attribution] if attribution is not None else [])
        if "FROM one_referral_relationships" in sql and "SELECT 1" in sql:
            return _Result([SimpleNamespace(x=1)] if existing_relationship else [])
        if "one_referral_policies" in sql:
            return _Result([_policy_row()])
        if "FROM actor_profiles" in sql:
            return _Result([SimpleNamespace(x=1)] if predates_attribution else [])
        if (
            "UPDATE one_referral_attributions" in sql
            or "INSERT INTO one_referral_relationships" in sql
        ):
            return _Result([])
        raise AssertionError(f"unexpected query: {sql}")

    conn = MagicMock()
    conn.execute.side_effect = execute
    return conn


@contextmanager
def _db(conn):
    yield conn


def test_self_referral_is_rejected_and_nothing_is_created():
    referrer_and_user = "user_same_person"
    attribution = _pending_attribution(referrer_user_id=referrer_and_user)
    conn = _harness(
        attribution=attribution, existing_relationship=False, predates_attribution=False
    )

    with patch.object(one_referral_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = one_referral_service.bind_attribution(ATTRIBUTION_ID, referrer_and_user)

    assert result == {"status": "self_referral"}
    # No UPDATE/INSERT call was made for the relationship or attribution bind.
    calls = [str(call.args[0]) for call in conn.execute.call_args_list]
    assert not any("UPDATE one_referral_attributions" in sql for sql in calls)
    assert not any("INSERT INTO one_referral_relationships" in sql for sql in calls)


def test_an_account_that_predates_the_link_is_not_credited_as_a_new_referral():
    attribution = _pending_attribution(referrer_user_id="user_referrer")
    conn = _harness(attribution=attribution, existing_relationship=False, predates_attribution=True)

    with patch.object(one_referral_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = one_referral_service.bind_attribution(ATTRIBUTION_ID, "user_existing")

    assert result == {"status": "existing_user"}
    calls = [str(call.args[0]) for call in conn.execute.call_args_list]
    assert not any("UPDATE one_referral_attributions" in sql for sql in calls)
    assert not any("INSERT INTO one_referral_relationships" in sql for sql in calls)


def test_a_new_user_who_did_not_predate_the_link_is_bound():
    attribution = _pending_attribution(referrer_user_id="user_referrer")
    conn = _harness(
        attribution=attribution, existing_relationship=False, predates_attribution=False
    )

    with patch.object(one_referral_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = one_referral_service.bind_attribution(ATTRIBUTION_ID, "user_brand_new")

    assert result == {"status": "bound"}


def test_a_user_already_referred_by_someone_else_cannot_be_credited_twice():
    attribution = _pending_attribution(referrer_user_id="user_second_referrer")
    conn = _harness(attribution=attribution, existing_relationship=True, predates_attribution=False)

    with patch.object(one_referral_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = one_referral_service.bind_attribution(ATTRIBUTION_ID, "user_already_referred")

    assert result == {"status": "already_referred"}
