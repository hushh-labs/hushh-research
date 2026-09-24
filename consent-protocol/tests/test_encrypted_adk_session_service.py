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
from hushh_mcp.one_adk.encrypted_session_service import (
    EncryptedAdkSessionService,
    EncryptedAdkSessionUnavailableError,
)


def test_session_document_encrypts_state_and_messages(monkeypatch) -> None:
    monkeypatch.setenv("APP_SIGNING_KEY", "a" * 32)
    monkeypatch.setenv("VAULT_DATA_KEY", "01" * 32)
    service = EncryptedAdkSessionService()
    session = Session(
        id="thread-1",
        app_name="hussh_one",
        user_id="owner-1",
        state={"private": "sensitive profile value"},
        events=[],
    )
    encoded = service._encode(session)
    assert "sensitive profile value" not in encoded["ciphertext"]
    decoded = service._decode(
        {
            "payload_ciphertext": encoded["ciphertext"],
            "payload_iv": encoded["iv"],
            "payload_tag": encoded["tag"],
            "payload_algorithm": encoded["algorithm"],
        }
    )
    assert decoded.state == session.state


def test_database_failure_never_exposes_sql_or_bound_values(monkeypatch) -> None:
    service = EncryptedAdkSessionService()
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

    service = EncryptedAdkSessionService()
    encoded = service._encode(session)
    assert "fixture" not in encoded["ciphertext"]
    decoded = service._decode({f"payload_{key}": value for key, value in encoded.items()})
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
    service = EncryptedAdkSessionService()
    encoded = service._encode(session)
    decoded = service._decode({f"payload_{key}": value for key, value in encoded.items()})
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
    service = EncryptedAdkSessionService()
    encoded = service._encode(session)
    decoded = service._decode({f"payload_{key}": value for key, value in encoded.items()})

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
    service = EncryptedAdkSessionService()
    encoded = service._encode(session)
    decoded = service._decode({f"payload_{key}": value for key, value in encoded.items()})
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
        EncryptedAdkSessionService()._encode(session)


@pytest.mark.asyncio
async def test_overlapping_snapshots_preserve_both_committed_events(monkeypatch):
    service = EncryptedAdkSessionService()
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
        service, "_decode", lambda stored: Session.model_validate_json(stored["payload_ciphertext"])
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
