from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import threading
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from hushh_mcp.services.action_directive_ledger import (
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
)


class _StatefulDirectiveDb:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = "none"
        self.requires_trusted_activation = False
        self.params: list[dict] = []
        self.sql: list[str] = []
        self.issued: dict = {}
        self.receipt_hash: str | None = None
        self.settlement: dict | None = None

    def execute_raw(self, sql: str, params: dict):
        with self.lock:
            self.params.append(dict(params))
            self.sql.append(sql)
            if "INSERT INTO one_action_directive_ledger" in sql:
                self.state = "issued"
                self.requires_trusted_activation = bool(params["trusted_activation_required"])
                self.issued = dict(params)
                return SimpleNamespace(data=[{"directive_id": params["directive_id"]}])
            if any(
                key in params and params[key] != self.issued.get(key)
                for key in (
                    "directive_id",
                    "user_id",
                    "action_id",
                    "context_revision",
                    "conversation_id",
                    "session_id",
                )
            ):
                return SimpleNamespace(data=[])
            if "SET state = 'confirmed'" in sql:
                if self.state != "issued" or (
                    self.requires_trusted_activation and not params["trusted_activation"]
                ):
                    return SimpleNamespace(data=[])
                self.state = "confirmed"
                self.receipt_hash = params["receipt_hash"]
                return SimpleNamespace(
                    data=[
                        {
                            "directive_id": params["directive_id"],
                            "expires_at": datetime.now(UTC) + timedelta(minutes=5),
                            "confirmed_at": datetime.now(UTC),
                        }
                    ]
                )
            if "SET state = 'consumed'" in sql:
                if self.state != "confirmed" or params["receipt_hash"] != self.receipt_hash:
                    return SimpleNamespace(data=[])
                self.state = "consumed"
                return SimpleNamespace(data=[{"directive_id": params["directive_id"]}])
            if "SET state = 'settled'" in sql:
                if self.state != "consumed" or params["receipt_hash"] != self.receipt_hash:
                    return SimpleNamespace(data=[])
                self.state = "settled"
                self.settlement = dict(params)
                return SimpleNamespace(data=[{"directive_id": params["directive_id"]}])
            if "SET state = 'cancelled'" in sql:
                if self.state not in {"issued", "confirmed", "consumed"}:
                    return SimpleNamespace(data=[])
                self.state = "cancelled"
                return SimpleNamespace(
                    data=[{"directive_id": params.get("directive_id", "cancelled")}]
                )
            return SimpleNamespace(data=[])


@pytest.mark.asyncio
async def test_directive_confirmation_and_consumption_are_one_time_and_metadata_only():
    db = _StatefulDirectiveDb()
    store = ActionDirectiveStore(db=db, hmac_key="test-key-at-least-32-characters-long")
    issued = await store.issue(
        user_id="user-1",
        channel="typed_chat",
        conversation_id="00000000-0000-0000-0000-000000000001",
        action_id="analysis.start",
        context_revision="route-1:screen-2",
        action_contract={"id": "analysis.start", "risk": "confirmation"},
        slots={"symbol": "SECRET-SYMBOL"},
    )
    insert_params = db.params[0]
    assert "slots" not in insert_params
    assert "SECRET-SYMBOL" not in repr(insert_params)

    results = await asyncio.gather(
        *[
            store.confirm(
                directive_id=issued.directive_id,
                user_id="user-1",
                conversation_id="00000000-0000-0000-0000-000000000001",
                action_id="analysis.start",
                context_revision="route-1:screen-2",
            )
            for _ in range(2)
        ],
        return_exceptions=True,
    )
    confirmations = [item for item in results if not isinstance(item, Exception)]
    failures = [item for item in results if isinstance(item, Exception)]
    assert len(confirmations) == 1
    assert len(failures) == 1
    assert isinstance(failures[0], ActionDirectiveAuthorityError)

    confirmation = confirmations[0]
    consume_results = await asyncio.gather(
        *[
            store.consume(
                directive_id=issued.directive_id,
                receipt=confirmation.receipt,
                user_id="user-1",
                conversation_id="00000000-0000-0000-0000-000000000001",
                action_id="analysis.start",
                context_revision="route-1:screen-2",
            )
            for _ in range(2)
        ],
        return_exceptions=True,
    )
    assert sum(item is None for item in consume_results) == 1
    assert sum(isinstance(item, ActionDirectiveAuthorityError) for item in consume_results) == 1


@pytest.mark.asyncio
async def test_wrong_context_cannot_confirm_directive():
    db = _StatefulDirectiveDb()
    store = ActionDirectiveStore(db=db, hmac_key="test-key-at-least-32-characters-long")
    issued = await store.issue(
        user_id="user-1",
        channel="voice",
        session_id="voice-session-1",
        action_id="route.profile",
        context_revision="profile-1",
        action_contract={"id": "route.profile"},
        slots={},
    )
    # The fake store models SQL compare-and-set state, while this assertion
    # proves the authoritative query carries the caller's exact context bind.
    with pytest.raises(ActionDirectiveAuthorityError):
        await store.confirm(
            directive_id=issued.directive_id,
            user_id="user-1",
            session_id="voice-session-1",
            action_id="route.profile",
            context_revision="different-context",
        )
    assert db.params[-1]["context_revision"] == "different-context"
    assert db.state == "issued"


@pytest.mark.asyncio
async def test_trusted_activation_directive_rejects_non_ui_confirmation():
    db = _StatefulDirectiveDb()
    store = ActionDirectiveStore(db=db, hmac_key="test-key-at-least-32-characters-long")
    issued = await store.issue(
        user_id="user-1",
        channel="voice",
        session_id="voice-session-1",
        action_id="route.profile",
        context_revision="profile-1",
        action_contract={"id": "route.profile"},
        slots={},
        trusted_activation_required=True,
    )

    with pytest.raises(ActionDirectiveAuthorityError):
        await store.confirm(
            directive_id=issued.directive_id,
            user_id="user-1",
            session_id="voice-session-1",
            action_id="route.profile",
            context_revision="profile-1",
            trusted_activation=False,
        )

    confirmation = await store.confirm(
        directive_id=issued.directive_id,
        user_id="user-1",
        session_id="voice-session-1",
        action_id="route.profile",
        context_revision="profile-1",
        trusted_activation=True,
    )
    assert confirmation.trusted_activation is True


@pytest.mark.asyncio
async def test_new_intent_cancels_an_authorized_directive_waiting_for_run():
    db = _StatefulDirectiveDb()
    store = ActionDirectiveStore(db=db, hmac_key="test-key-at-least-32-characters-long")
    conversation_id = "00000000-0000-0000-0000-000000000001"
    issued = await store.issue(
        user_id="user-1",
        channel="typed_chat",
        conversation_id=conversation_id,
        action_id="analysis.start",
        context_revision="route-1:screen-2",
        action_contract={"id": "analysis.start"},
        slots={},
        trusted_activation_required=True,
    )
    confirmation = await store.confirm(
        directive_id=issued.directive_id,
        user_id="user-1",
        conversation_id=conversation_id,
        action_id="analysis.start",
        context_revision="route-1:screen-2",
        trusted_activation=True,
    )
    await store.consume(
        directive_id=issued.directive_id,
        receipt=confirmation.receipt,
        user_id="user-1",
        conversation_id=conversation_id,
        action_id="analysis.start",
        context_revision="route-1:screen-2",
    )

    await store.cancel_open_for_conversation(user_id="user-1", conversation_id=conversation_id)

    assert db.state == "cancelled"
    assert "state IN ('issued', 'confirmed', 'consumed')" in db.sql[-1]

    voice_db = _StatefulDirectiveDb()
    voice_store = ActionDirectiveStore(db=voice_db, hmac_key="test-key-at-least-32-characters-long")
    voice_issued = await voice_store.issue(
        user_id="user-1",
        channel="voice",
        session_id="voice-session-1",
        action_id="route.profile",
        context_revision="voice-context-1",
        action_contract={"id": "route.profile"},
        slots={},
        trusted_activation_required=True,
    )
    voice_confirmation = await voice_store.confirm(
        directive_id=voice_issued.directive_id,
        user_id="user-1",
        session_id="voice-session-1",
        action_id="route.profile",
        context_revision="voice-context-1",
        trusted_activation=True,
    )
    await voice_store.consume(
        directive_id=voice_issued.directive_id,
        receipt=voice_confirmation.receipt,
        user_id="user-1",
        session_id="voice-session-1",
        action_id="route.profile",
        context_revision="voice-context-1",
    )

    await voice_store.cancel_voice(
        directive_id=voice_issued.directive_id,
        user_id="user-1",
        session_id="voice-session-1",
        action_id="route.profile",
    )

    assert voice_db.state == "cancelled"
    assert "state IN ('issued', 'confirmed', 'consumed')" in voice_db.sql[-1]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("action_id", "slot_name"),
    [
        ("connect.send_request", "userId"),
        ("connect.accept_request", "requestId"),
        ("connect.reject_request", "requestId"),
        ("connect.cancel_request", "requestId"),
        ("connect.remove_connection", "connectionId"),
    ],
)
async def test_exact_connection_slots_bind_metadata_through_one_time_settlement(
    action_id, slot_name
):
    """Ledger-level authority proof; browser slot transport is tested separately.

    The ledger stores only a commitment, never returns the slots, and cannot by
    itself prove that a domain mutation or frontend replay uses these slots.
    """
    db = _StatefulDirectiveDb()
    key = "test-key-at-least-32-characters-long"
    store = ActionDirectiveStore(db=db, hmac_key=key)
    slots = {slot_name: "Opaque-Fixture:AbC-009", "person": "Fixture Person"}
    original_slots = deepcopy(slots)
    context = dict(
        user_id="fixture-owner",
        conversation_id="00000000-0000-0000-0000-000000000003",
        action_id=action_id,
        context_revision="connections-revision-1",
    )
    issued = await store.issue(
        **context,
        channel="typed_chat",
        slots=slots,
        action_contract={"id": action_id, "execution_policy": "confirm_required"},
        trusted_activation_required=True,
    )
    expected_hmac = hmac.new(
        key.encode(),
        json.dumps(slots, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode(),
        hashlib.sha256,
    ).hexdigest()
    assert db.issued["slots_hmac"] == expected_hmac
    assert slots[slot_name] not in repr(db.issued)
    assert "slots" not in db.issued
    issued_metadata = deepcopy(db.issued)
    confirmation = await store.confirm(
        **context, directive_id=issued.directive_id, trusted_activation=True
    )

    async def consume_once():
        await store.consume(
            **context, directive_id=issued.directive_id, receipt=confirmation.receipt
        )
        return "authority_consumed"

    outcomes = await asyncio.gather(consume_once(), consume_once(), return_exceptions=True)
    assert outcomes.count("authority_consumed") == 1
    assert sum(isinstance(outcome, ActionDirectiveAuthorityError) for outcome in outcomes) == 1
    settlement = dict(
        directive_id=issued.directive_id,
        receipt=confirmation.receipt,
        user_id=context["user_id"],
        action_id=action_id,
        context_revision=context["context_revision"],
        status="succeeded",
        reason_code="fixture_applied",
    )
    await store.settle(**settlement)
    persisted_outcome = deepcopy(db.settlement)
    with pytest.raises(ActionDirectiveAuthorityError):
        await consume_once()
    with pytest.raises(ActionDirectiveAuthorityError):
        await store.settle(**{**settlement, "status": "failed", "reason_code": "duplicate_attempt"})
    with pytest.raises(ActionDirectiveAuthorityError):
        await store.confirm(**context, directive_id=issued.directive_id, trusted_activation=True)
    assert db.state == "settled"
    assert db.settlement == persisted_outcome
    assert db.issued == issued_metadata
    assert slots == original_slots

    # Exact identifiers are case-sensitive commitments, not name-resolution hints.
    changed_db = _StatefulDirectiveDb()
    changed_store = ActionDirectiveStore(db=changed_db, hmac_key=key)
    await changed_store.issue(
        **context,
        channel="typed_chat",
        action_contract={"id": action_id, "execution_policy": "confirm_required"},
        slots={**slots, slot_name: slots[slot_name].lower()},
    )
    assert changed_db.issued["slots_hmac"] != expected_hmac


@pytest.mark.asyncio
async def test_connection_receipt_rejects_wrong_owner_and_receipt_without_consuming():
    db = _StatefulDirectiveDb()
    store = ActionDirectiveStore(db=db, hmac_key="test-key-at-least-32-characters-long")
    context = dict(
        user_id="fixture-owner",
        conversation_id="00000000-0000-0000-0000-000000000004",
        action_id="connect.remove_connection",
        context_revision="connections-revision-1",
    )
    issued = await store.issue(
        **context,
        channel="typed_chat",
        slots={"connectionId": "fixture-connection"},
        action_contract={"id": context["action_id"]},
    )
    confirmation = await store.confirm(**context, directive_id=issued.directive_id)
    for override in (
        {"user_id": "different-owner"},
        {"receipt": "wrong-receipt"},
        {"context_revision": "different-revision"},
    ):
        with pytest.raises(ActionDirectiveAuthorityError):
            await store.consume(
                **{
                    **context,
                    "directive_id": issued.directive_id,
                    "receipt": confirmation.receipt,
                    **override,
                }
            )
        assert db.state == "confirmed"
    await store.consume(**context, directive_id=issued.directive_id, receipt=confirmation.receipt)
    assert db.state == "consumed"
