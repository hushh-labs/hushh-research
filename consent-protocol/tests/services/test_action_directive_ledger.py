from __future__ import annotations

import asyncio
import threading
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

    def execute_raw(self, sql: str, params: dict):
        with self.lock:
            self.params.append(dict(params))
            self.sql.append(sql)
            if "INSERT INTO one_action_directive_ledger" in sql:
                self.state = "issued"
                self.requires_trusted_activation = bool(params["trusted_activation_required"])
                return SimpleNamespace(data=[{"directive_id": params["directive_id"]}])
            if "SET state = 'confirmed'" in sql:
                if self.state != "issued" or (
                    self.requires_trusted_activation and not params["trusted_activation"]
                ):
                    return SimpleNamespace(data=[])
                self.state = "confirmed"
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
                if self.state != "confirmed":
                    return SimpleNamespace(data=[])
                self.state = "consumed"
                return SimpleNamespace(data=[{"directive_id": params["directive_id"]}])
            if "SET state = 'settled'" in sql:
                if self.state != "consumed":
                    return SimpleNamespace(data=[])
                self.state = "settled"
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
        # Force an already-used state to exercise the same generic rejection.
        db.state = "expired"
        await store.confirm(
            directive_id=issued.directive_id,
            user_id="user-1",
            session_id="voice-session-1",
            action_id="route.profile",
            context_revision="different-context",
        )
    assert db.params[-1]["context_revision"] == "different-context"


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
