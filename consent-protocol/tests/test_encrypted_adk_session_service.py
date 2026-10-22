import asyncio
from types import SimpleNamespace

import pytest
from google.adk.events import Event, EventActions
from google.adk.sessions import Session
from google.adk.sessions.base_session_service import GetSessionConfig
from google.genai import types
from pydantic import ConfigDict
from pydantic_core import PydanticSerializationError

from db.db_client import DatabaseExecutionError
from db.query_telemetry import (
    begin_query_telemetry,
    query_telemetry_snapshot,
    reset_query_telemetry,
)
from hushh_mcp.one_adk.encrypted_session_service import (
    EncryptedAdkSessionService,
    EncryptedAdkSessionUnavailableError,
    session_payload_aad,
)
from tests.helpers.chat_keys import static_chat_cipher


def _decode_as(service, session, row):
    return service._decode(
        row, app_name=session.app_name, user_id=session.user_id, session_id=session.id
    )


def test_session_document_encrypts_state_and_messages(monkeypatch) -> None:
    monkeypatch.setenv("APP_SIGNING_KEY", "a" * 32)
    service = EncryptedAdkSessionService(static_chat_cipher())
    session = Session(
        id="thread-1",
        app_name="hussh_one",
        user_id="owner-1",
        state={"private": "sensitive profile value"},
        events=[],
    )
    encoded = service._encode(session)
    assert "sensitive profile value" not in encoded["ciphertext"]
    decoded = _decode_as(
        service,
        session,
        {
            "payload_ciphertext": encoded["ciphertext"],
            "payload_iv": encoded["iv"],
            "payload_tag": encoded["tag"],
            "payload_algorithm": encoded["algorithm"],
        },
    )
    assert decoded.state == session.state


def test_database_failure_never_exposes_sql_or_bound_values(monkeypatch) -> None:
    service = EncryptedAdkSessionService(static_chat_cipher())
    private_value = "owner-secret-ciphertext"

    def fail_execute(*_args, **_kwargs):
        raise DatabaseExecutionError(
            table_name="<raw_sql>",
            operation="execute_raw",
            details=f"INSERT INTO one_adk_sessions [parameters: {private_value}]",
        )

    monkeypatch.setattr(
        "hushh_mcp.one_adk.encrypted_session_service.get_db",
        lambda: type(
            "FailingDatabase",
            (),
            {"execute_raw": staticmethod(fail_execute)},
        )(),
    )

    with pytest.raises(EncryptedAdkSessionUnavailableError) as caught:
        asyncio.run(service._execute("INSERT secret", {"payload": private_value}))

    rendered = str(caught.value)
    assert rendered == "Conversation storage is temporarily unavailable."
    assert private_value not in rendered
    assert "INSERT" not in rendered


@pytest.mark.asyncio
async def test_async_session_query_uses_pool_telemetry_and_one_transient_retry(monkeypatch):
    service = EncryptedAdkSessionService(static_chat_cipher())
    calls: list[tuple[str, tuple[object, ...]]] = []

    class Connection:
        async def fetch(self, query, *values):
            calls.append((query, values))
            if len(calls) == 1:
                raise ConnectionError("synthetic connection reset")
            return [{"revision": 7}]

    class Acquire:
        async def __aenter__(self):
            return Connection()

        async def __aexit__(self, *_args):
            return False

    class Pool:
        def acquire(self):
            return Acquire()

    async def pool():
        return Pool()

    monkeypatch.setattr("hushh_mcp.one_adk.encrypted_session_service.get_pool", pool)
    token = begin_query_telemetry()
    try:
        result = await service._execute(
            "SELECT revision FROM one_adk_sessions WHERE user_id = :owner OR user_id = :owner",
            {"owner": "private-owner"},
        )
        telemetry = query_telemetry_snapshot()
    finally:
        reset_query_telemetry(token)

    assert result.data == [{"revision": 7}]
    assert calls == [
        (
            "SELECT revision FROM one_adk_sessions WHERE user_id = $1 OR user_id = $2",
            ("private-owner", "private-owner"),
        ),
        (
            "SELECT revision FROM one_adk_sessions WHERE user_id = $1 OR user_id = $2",
            ("private-owner", "private-owner"),
        ),
    ]
    assert telemetry["sql_count"] == 2
    assert telemetry["repeated_sql_count"] == 1


@pytest.mark.parametrize("placement", ["output", "state", "actions"])
def test_deferred_genai_models_roundtrip_without_mutating_live_objects(placement):
    # Per-test subclasses preserve GenAI's real serializer behavior without
    # changing global SDK classes or depending on another test's import order.
    class DeferredResponse(types.GenerateContentResponse):
        model_config = ConfigDict(defer_build=True)

    class DeferredCandidate(types.Candidate):
        model_config = ConfigDict(defer_build=True)

    candidate = DeferredCandidate.model_construct(index=3)
    response = DeferredResponse.model_construct(candidates=[candidate], model_version="fixture")
    event = Event(author="finance")
    session = Session(id="thread", app_name="one", user_id="owner", events=[event])
    if placement == "output":
        event.output = response
    elif placement == "state":
        session.state["response"] = response
    else:
        event.actions = EventActions(agent_state={"response": response})
    assert not DeferredResponse.__pydantic_complete__
    with pytest.raises(PydanticSerializationError, match="MockValSer"):
        session.model_dump_json(by_alias=True)

    service = EncryptedAdkSessionService(static_chat_cipher())
    encoded = service._encode(session)
    assert "fixture" not in encoded["ciphertext"]
    decoded = _decode_as(
        service, session, {f"payload_{key}": value for key, value in encoded.items()}
    )
    if placement == "output":
        restored = decoded.events[0].output
        assert event.output is response
    elif placement == "state":
        restored = decoded.state["response"]
        assert session.state["response"] is response
    else:
        restored = decoded.events[0].actions.agent_state["response"]
        assert event.actions.agent_state["response"] is response
    assert restored["modelVersion"] == "fixture"
    assert restored["candidates"][0]["index"] == 3
    assert response.candidates[0] is candidate


def test_session_serializer_preserves_sdk_bytes_and_event_types():
    content = types.Content(role="model", parts=[types.Part(thought_signature=b"\xff\x00\x81")])
    session = Session(
        id="thread", app_name="one", user_id="owner", events=[Event(author="one", content=content)]
    )
    service = EncryptedAdkSessionService(static_chat_cipher())
    encoded = service._encode(session)
    decoded = _decode_as(
        service, session, {f"payload_{key}": value for key, value in encoded.items()}
    )
    assert isinstance(decoded.events[0], Event)
    assert decoded.events[0].content.parts[0].thought_signature == b"\xff\x00\x81"


def test_drive_result_is_available_live_but_not_retained_in_session():
    private_value = "PRIVATE_DRIVE_SENTINEL"
    response = types.FunctionResponse(
        name="read_google_drive",
        id="drive-call-1",
        response={"source": "google_drive_mcp", "status": "ok", "result": private_value},
    )
    event = Event(
        author="one",
        content=types.Content(role="tool", parts=[types.Part(function_response=response)]),
    )
    session = Session(id="thread", app_name="one", user_id="owner", events=[event])
    service = EncryptedAdkSessionService(static_chat_cipher())
    encoded = service._encode(session)
    decoded = _decode_as(
        service, session, {f"payload_{key}": value for key, value in encoded.items()}
    )

    assert event.content.parts[0].function_response.response["result"] == private_value
    assert private_value not in decoded.model_dump_json(by_alias=True)
    restored = decoded.events[0].content.parts[0].function_response
    assert restored.name == "read_google_drive"
    assert restored.response == {
        "status": "ok",
        "private_result": "not_retained",
        "truncated": False,
    }


def test_drive_call_arguments_remain_live_but_not_retained():
    private_value = "PRIVATE_DRIVE_SEARCH_SENTINEL"
    call = types.FunctionCall(
        name="read_google_drive", id="drive-call-1", args={"query": private_value}
    )
    session = Session(
        id="thread",
        app_name="one",
        user_id="owner",
        events=[Event(author="one", content=types.Content(parts=[types.Part(function_call=call)]))],
    )
    service = EncryptedAdkSessionService(static_chat_cipher())
    encoded = service._encode(session)
    decoded = _decode_as(
        service, session, {f"payload_{key}": value for key, value in encoded.items()}
    )
    assert call.args == {"query": private_value}
    assert private_value not in decoded.model_dump_json(by_alias=True)
    restored = decoded.events[0].content.parts[0].function_call
    assert restored.name == "read_google_drive"
    assert restored.id == "drive-call-1"
    assert restored.args == {}


def test_unrelated_serialization_failure_is_not_repaired(monkeypatch):
    def unexpected_repair(_session):
        pytest.fail("Unrelated failures must not invoke deferred-model repair")

    monkeypatch.setattr(
        "hushh_mcp.one_adk.encrypted_session_service._prepare_deferred_model_serializers",
        unexpected_repair,
    )
    session = Session(id="thread", app_name="one", user_id="owner", state={"invalid": object()})
    with pytest.raises(PydanticSerializationError, match="unknown type"):
        EncryptedAdkSessionService(static_chat_cipher())._encode(session)


@pytest.mark.asyncio
async def test_overlapping_snapshots_preserve_both_committed_events(monkeypatch):
    service = EncryptedAdkSessionService(static_chat_cipher())
    row = None

    def encode(session):
        return {
            "ciphertext": session.model_dump_json(by_alias=True),
            "iv": "",
            "tag": "",
            "algorithm": "fixture",
        }

    monkeypatch.setattr(service, "_encode", encode)
    monkeypatch.setattr(
        service,
        "_decode",
        lambda stored, **_identity: Session.model_validate_json(stored["payload_ciphertext"]),
    )

    async def execute(sql, params):
        nonlocal row
        if "INSERT INTO one_adk_sessions" in sql:
            row = {
                "revision": 1,
                **{
                    f"payload_{key}": value
                    for key, value in params.items()
                    if key in {"ciphertext", "iv", "tag", "algorithm"}
                },
            }
            return SimpleNamespace(data=[{"revision": 1}])
        if "SELECT payload_ciphertext" in sql:
            return SimpleNamespace(data=[dict(row)] if row else [])
        if "UPDATE one_adk_sessions" in sql:
            if row is None or row["revision"] != params["revision"]:
                return SimpleNamespace(data=[])
            row = {
                "revision": row["revision"] + 1,
                **{
                    f"payload_{key}": value
                    for key, value in params.items()
                    if key in {"ciphertext", "iv", "tag", "algorithm"}
                },
            }
            return SimpleNamespace(data=[{"revision": row["revision"]}])
        raise AssertionError("Unexpected SQL")

    monkeypatch.setattr(service, "_execute", execute)
    await service.create_session(app_name="one", user_id="owner", session_id="thread")
    first = await service.get_session(app_name="one", user_id="owner", session_id="thread")
    second = await service.get_session(app_name="one", user_id="owner", session_id="thread")
    assert first is not None and second is not None

    await service.append_event(first, Event(author="first", timestamp=1.0))
    await service.append_event(second, Event(author="second", timestamp=2.0))

    recent = await service.get_session(
        app_name="one",
        user_id="owner",
        session_id="thread",
        config=GetSessionConfig(num_recent_events=1),
    )
    assert recent is not None
    assert [event.author for event in recent.events] == ["second"]
    await service.append_event(recent, Event(author="third", timestamp=3.0))

    since = await service.get_session(
        app_name="one",
        user_id="owner",
        session_id="thread",
        config=GetSessionConfig(after_timestamp=2.5),
    )
    assert since is not None
    assert [event.author for event in since.events] == ["third"]
    await service.append_event(since, Event(author="fourth", timestamp=4.0))

    none = await service.get_session(
        app_name="one",
        user_id="owner",
        session_id="thread",
        config=GetSessionConfig(num_recent_events=0),
    )
    assert none is not None and none.events == []
    await service.append_event(none, Event(author="fifth", timestamp=5.0))

    persisted = await service.get_session(app_name="one", user_id="owner", session_id="thread")
    assert persisted is not None
    assert [event.author for event in persisted.events] == [
        "first",
        "second",
        "third",
        "fourth",
        "fifth",
    ]
    assert "_hushh_revision" not in persisted.model_dump_json()
    assert "_hushh_partial_history" not in persisted.model_dump_json()

    receipt = Event(
        id="request_submission_source_1",
        author="one",
        custom_metadata={"kind": "information_request_submission_v1", "sourceCardId": "source_1"},
    )
    await asyncio.gather(
        *(
            service.append_event_once(
                app_name="one", user_id="owner", session_id="thread", event=receipt
            )
            for _ in range(3)
        )
    )
    after_retry = await service.get_session(app_name="one", user_id="owner", session_id="thread")
    assert after_retry is not None
    assert [event.id for event in after_retry.events].count("request_submission_source_1") == 1


def test_a_row_sealed_with_invocation_state_opens_without_it(monkeypatch) -> None:
    """Rows sealed before 2026-09-28 hold an answer turn's ``temp:`` record; a
    new invocation must never start with it (the same-chat consent leak)."""
    monkeypatch.setenv("APP_SIGNING_KEY", "a" * 32)
    service = EncryptedAdkSessionService(static_chat_cipher())
    session = Session(
        id="thread-1",
        app_name="hussh_one",
        user_id="owner-1",
        state={"hussh:kept": 1, "temp:hussh:consent_continuation": {"shared": "ref"}},
        events=[],
    )
    legacy = service._cipher.seal(
        session.model_dump_json(by_alias=True),
        owner_id=session.user_id,
        aad=session_payload_aad(session.app_name, session.id),
    )
    row = {
        "payload_ciphertext": legacy.ciphertext,
        "payload_iv": legacy.iv,
        "payload_tag": legacy.tag,
        "payload_algorithm": legacy.algorithm,
    }
    assert _decode_as(service, session, row).state == {"hussh:kept": 1}
    # And nothing new is sealed with it, while the live session keeps it.
    fresh = _decode_as(
        service,
        session,
        {f"payload_{key}": value for key, value in service._encode(session).items()},
    )
    assert fresh.state == {"hussh:kept": 1}
    assert "temp:hussh:consent_continuation" in session.state


class _Rows:
    """``one_adk_sessions`` for the statements the store issues, over real sealing."""

    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}

    async def execute(self, sql: str, params: dict):
        statement = " ".join(sql.split())
        fields = {
            f"payload_{key}": params[key]
            for key in ("ciphertext", "iv", "tag", "algorithm")
            if key in params
        }
        if statement.startswith("INSERT"):
            self.rows[params["session"]] = {**fields, "revision": 1}
            return SimpleNamespace(data=[{"revision": 1}])
        if statement.startswith("SELECT session_id"):
            return SimpleNamespace(
                data=[{"session_id": key, **row} for key, row in self.rows.items()]
            )
        if statement.startswith("SELECT"):
            row = self.rows.get(params["session"])
            return SimpleNamespace(data=[dict(row)] if row else [])
        row = self.rows[params["session"]]
        if row["revision"] != params["revision"]:
            return SimpleNamespace(data=[])
        row.update(fields, revision=row["revision"] + 1)
        return SimpleNamespace(data=[{"revision": row["revision"]}])


def _stale_temp_records(caplog) -> list:
    return [r for r in caplog.records if "sealed_temp_state_dropped" in r.getMessage()]


@pytest.mark.asyncio
async def test_stale_temp_state_is_reported_once_per_legacy_row_and_never_for_a_live_turn(
    monkeypatch, caplog
) -> None:
    """Measured 2026-09-28: 277 INFO lines, about 14 per turn, all from every
    conversation-list poll re-reading the same legacy rows (reads never reseal)."""
    from collections import OrderedDict

    from hushh_mcp.one_adk import encrypted_session_service

    monkeypatch.setenv("APP_SIGNING_KEY", "a" * 32)
    monkeypatch.setattr(encrypted_session_service, "_REPORTED_STALE_TEMP_STATE", OrderedDict())
    service = EncryptedAdkSessionService(static_chat_cipher())
    rows = _Rows()
    monkeypatch.setattr(service, "_execute", rows.execute)
    caplog.set_level("DEBUG", logger=encrypted_session_service.__name__)

    # A normal turn: the running invocation holds ``temp:`` values in memory.
    live = await service.create_session(app_name="one", user_id="owner", session_id="live")
    await service.append_event(
        live,
        Event(
            author="one",
            timestamp=1.0,
            actions=EventActions(state_delta={"temp:hussh:turn": 1, "hussh:kept": 1}),
        ),
    )
    assert live.state["temp:hussh:turn"] == 1
    for _poll in range(3):
        await service.list_sessions(app_name="one", user_id="owner")
    assert (
        await service.get_session(app_name="one", user_id="owner", session_id="live")
    ).state == {"hussh:kept": 1}
    assert _stale_temp_records(caplog) == []

    # A legacy row sealed with an earlier turn's ``temp:`` values.
    legacy = Session(
        id="legacy",
        app_name="one",
        user_id="owner",
        state={"hussh:kept": 2, "temp:hussh:consent_continuation": {"shared": "ref"}},
        events=[],
    )
    sealed = service._cipher.seal(
        legacy.model_dump_json(by_alias=True),
        owner_id="owner",
        aad=session_payload_aad("one", "legacy"),
    )
    rows.rows["legacy"] = {
        "payload_ciphertext": sealed.ciphertext,
        "payload_iv": sealed.iv,
        "payload_tag": sealed.tag,
        "payload_algorithm": sealed.algorithm,
        "revision": 1,
    }
    for _poll in range(3):
        listed = await service.list_sessions(app_name="one", user_id="owner")
        # Behaviour is unchanged: every read drops the stale value.
        assert {s.id: s.state for s in listed.sessions}["legacy"] == {"hussh:kept": 2}

    records = _stale_temp_records(caplog)
    assert [record.levelname for record in records] == ["INFO", "DEBUG", "DEBUG"]
    assert all(record.getMessage().endswith("count=1") for record in records)


def test_reactions_never_enter_sealed_history_but_live_tool_results_remain():
    from hushh_mcp.one_adk.message_reactions import REACTION_TOOL_NAME
    from hushh_mcp.one_adk.turn_completion import newest_turn_answered

    service = EncryptedAdkSessionService(static_chat_cipher())
    call = types.Part(
        function_call=types.FunctionCall(name=REACTION_TOOL_NAME, args={"emoji": "💛"})
    )
    result = types.Part.from_function_response(
        name=REACTION_TOOL_NAME, response={"status": "shown", "emoji": "💛"}
    )
    session = Session(
        id="reaction-test",
        app_name="hussh_one",
        user_id="owner-1",
        state={"temp:message_reaction_shown": True},
        events=[
            Event(
                author="one",
                content=types.Content(role="model", parts=[types.Part(text="Your answer"), call]),
            ),
            Event(
                author="one",
                content=types.Content(role="user", parts=[result]),
                actions=EventActions(
                    state_delta={"temp:message_reaction_shown": True}, skip_summarization=True
                ),
            ),
        ],
    )
    encoded = service._encode(session)
    decoded = _decode_as(
        service,
        session,
        {
            "payload_ciphertext": encoded["ciphertext"],
            "payload_iv": encoded["iv"],
            "payload_tag": encoded["tag"],
            "payload_algorithm": encoded["algorithm"],
        },
    )
    durable = decoded.model_dump_json()
    assert REACTION_TOOL_NAME not in durable
    assert "💛" not in durable
    assert "message_reaction_shown" not in durable
    assert "Your answer" in durable
    assert newest_turn_answered(decoded.events)
    assert session.events[0].content.parts[1].function_call.name == REACTION_TOOL_NAME
    assert session.events[1].content.parts[0].function_response.response["emoji"] == "💛"
