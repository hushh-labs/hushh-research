"""The payout doorbell names an owner and closed kinds, never money or provider data."""

import json
from uuid import uuid4

import pytest

from hushh_mcp.services.payout_doorbell import (
    PayoutDoorbellError,
    notify_payout_changed,
    payout_doorbell_payload,
)


def test_payload_is_deterministic_and_closed():
    request_id = uuid4()
    first = payout_doorbell_payload("owner", ["wallet", "earnings", "wallet", "bogus"], request_id)
    second = payout_doorbell_payload("owner", ["earnings", "wallet"], str(request_id))
    # Identical payloads collapse inside one transaction, so order and
    # duplicates must not change the bytes.
    assert first == second
    assert json.loads(first) == {
        "type": "bank_payout_changed",
        "user_id": "owner",
        "kinds": ["earnings", "wallet"],
        "request_id": str(request_id),
    }


@pytest.mark.parametrize(
    ("user_id", "kinds", "request_id"),
    [
        ("", ["wallet"], None),
        ("x" * 129, ["wallet"], None),
        ("owner", ["bogus"], None),
        ("owner", [], None),
        ("owner", ["wallet"], "not-a-uuid"),
    ],
)
def test_ambiguous_doorbells_are_refused(user_id, kinds, request_id):
    with pytest.raises((PayoutDoorbellError, ValueError)):
        payout_doorbell_payload(user_id, kinds, request_id)


def test_notify_uses_the_owner_state_channel():
    calls = []

    class Connection:
        def execute(self, statement, params):
            calls.append((str(statement), params))

    notify_payout_changed(Connection(), "owner", ["bank_payouts"])
    assert calls == [
        (
            "SELECT pg_notify('one_user_state_changed', :payload)",
            {
                "payload": '{"kinds":["bank_payouts"],"type":"bank_payout_changed","user_id":"owner"}'
            },
        )
    ]
