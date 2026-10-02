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


async def test_explicit_repository_keeps_owner_cipher_and_never_uses_hub_database(monkeypatch):
    from unittest.mock import AsyncMock

    from hushh_mcp.services.chat_key import ChatKeyMismatchError

    class EmptyRepository:
        def __bool__(self):
            return False

    repository = EmptyRepository()
    repository.create = AsyncMock(return_value=SimpleNamespace(data=[{"revision": 1}]))
    repository.get = AsyncMock()
    monkeypatch.setattr(
        "hushh_mcp.one_adk.encrypted_session_service.get_db",
        lambda: pytest.fail("explicit runtime repository reached hub database"),
    )
    service = EncryptedAdkSessionService(static_chat_cipher(), repository=repository)
    session = await service.create_session(
        app_name="one",
        user_id="owner",
        session_id="thread",
        state={"note": "synthetic private note"},
    )
    sealed = repository.create.call_args.kwargs
    assert sealed["user"] == "owner"
    assert "synthetic private note" not in str(sealed)
    repository.get.return_value = SimpleNamespace(
        data=[
            {
                "session_id": "thread",
                "revision": 1,
                **{
                    "payload_" + key: sealed[key]
                    for key in ("ciphertext", "iv", "tag", "algorithm")
                },
            }
        ]
    )
    restored = await service.get_session(app_name="one", user_id="owner", session_id="thread")
    assert restored.state == session.state
    foreign = EncryptedAdkSessionService(static_chat_cipher("ab" * 32), repository=repository)
    with pytest.raises(ChatKeyMismatchError):
        await foreign.get_session(app_name="one", user_id="owner", session_id="thread")


@pytest.mark.asyncio
async def test_pod_repository_recovers_owner_cipher_and_rejects_stale_or_revoked_access(
    tmp_path, monkeypatch
):
    from hushh_mcp.one_adk import pod_adk_checkpoint
    from hushh_mcp.one_adk.pod_adk_session_repository import (
        PodAdkSessionProjection,
        PodAdkSessionRepository,
        PodAdkSessionUnavailable,
    )
    from hushh_mcp.services.chat_key import CHAT_CIPHERTEXT_LIKE
    from hushh_mcp.services.pod_commit_log import (
        LocalObjectStore,
        PodCommitLog,
        PodLogFenced,
        PodLogTampered,
    )

    monkeypatch.setattr(pod_adk_checkpoint, "INTERVAL", 1)

    monkeypatch.setattr(
        "hushh_mcp.one_adk.encrypted_session_service.get_db",
        lambda: pytest.fail("private conversation reached hub database"),
    )
    log = PodCommitLog(LocalObjectStore(str(tmp_path / "log")), b"k" * 32, owner_id="HA1fixture")
    admitted = True

    async def access():
        if not admitted:
            raise PermissionError("session expired")

    def repository():
        return PodAdkSessionRepository(
            projection=PodAdkSessionProjection(owner_id="owner", hushh_id="HA1fixture", log=log),
            require_access=access,
        )

    repo = repository()
    service = EncryptedAdkSessionService(static_chat_cipher(), repository=repo)
    identity = {"app_name": "hussh_one", "user_id": "owner", "session_id": "fixture-chat"}
    session = await service.create_session(**identity, state={"fixture": "synthetic private text"})
    old = await service.get_session(**identity)
    await service.append_event(
        session,
        Event(
            author="user",
            content=types.Content(role="user", parts=[types.Part(text="synthetic message")]),
        ),
    )
    # A second request gets a fresh admission callback and may share only sealed records.
    restarted_repo = repository()
    restarted = EncryptedAdkSessionService(static_chat_cipher(), repository=restarted_repo)
    restored = await restarted.get_session(**identity)
    assert restored.state["fixture"] == "synthetic private text"
    assert len(restored.events) == 1
    assert "synthetic private text" not in repr(restarted_repo._projection._entries)
    # Once checkpointed, cold recovery reads no historic record objects.
    with monkeypatch.context() as patch:

        async def no_history_read(_key):
            pytest.fail("checkpoint recovery replayed old records")

        patch.setattr(log._store, "get", no_history_read)
        cold = EncryptedAdkSessionService(static_chat_cipher(), repository=repository())
        assert len((await cold.get_session(**identity)).events) == 1
    coords = {
        "app": "hussh_one",
        "user": "owner",
        "session": "fixture-chat",
        "chat_marker": CHAT_CIPHERTEXT_LIKE,
    }
    assert not (
        await repo.replace(**coords, revision=service._revision(old), **service._encode(old))
    ).data
    with pytest.raises(PodAdkSessionUnavailable, match="owner mismatch"):
        await repo.get(**{**coords, "user": "foreign"})
    admitted = False
    with pytest.raises(PermissionError, match="expired"):
        await restarted.get_session(**identity)  # warm cache does not confer authority
    admitted = True
    await restarted.delete_session(**identity)
    assert await service.get_session(**identity) is None
    assert not (
        await repo.replace(
            **coords, revision=service._revision(restored), **service._encode(restored)
        )
    ).data
    assert (
        await EncryptedAdkSessionService(static_chat_cipher(), repository=repository()).get_session(
            **identity
        )
        is None
    )
    blob, generation = await log._store.get_with_generation(pod_adk_checkpoint.KEY)
    assert b"synthetic message" not in blob
    # A stale cache publisher cannot replace the current encrypted checkpoint.
    stale = str(int(generation) - 1 or "")  # the version before the current one
    assert await log._store.put_if_generation(pod_adk_checkpoint.KEY, blob, stale) is None
    corrupted_generation = await log._store.put_if_generation(
        pod_adk_checkpoint.KEY, blob[:-1] + bytes([blob[-1] ^ 1]), generation
    )
    with pytest.raises(PodLogTampered):
        await repository().get(**coords)
    await log._store.put_if_generation(pod_adk_checkpoint.KEY, blob, corrupted_generation)
    await log.fence_for_erasure(owner_id="HA1fixture", attempt_id="fixture-erasure")
    with pytest.raises(PodLogFenced):
        await restarted.get_session(**identity)


@pytest.mark.asyncio
async def test_pod_chat_recovers_across_more_than_ten_thousand_unrelated_commits():
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from hushh_mcp.one_adk.pod_adk_session_repository import PodAdkSessionProjection
    from hushh_mcp.services.pod_commit_log import PodCommitLog, _canonical, _record_sha

    objects = {}
    store = SimpleNamespace(
        get=AsyncMock(side_effect=lambda key: objects.get(key)),
        get_with_generation=AsyncMock(side_effect=lambda key: (objects.get(key), "1")),
        put_if_generation=AsyncMock(return_value="2"),
    )
    log = PodCommitLog(store, b"k" * 32, owner_id="HA1fixture")
    previous_key = previous_sha = None
    for seq in range(1, 10002):
        kind, payload = "unrelated", {}
        if seq == 1:
            kind = "pod.adk.session.v1"
            payload = {
                "format": 1,
                "owner": "owner",
                "hushhId": "HA1fixture",
                "app": "one",
                "session": "fixture",
                "previous": 0,
                "operation": "delete",
            }
        digest = _record_sha(seq, kind, payload, previous_sha)
        key = f"records/{seq:012d}-abcdef12.bin"
        objects[key] = log._seal(
            {
                "seq": seq,
                "kind": kind,
                "payload": payload,
                "prev_key": previous_key,
                "prev_sha": previous_sha,
                "sha": digest,
            }
        )
        previous_key, previous_sha = key, digest
    objects[log.HEAD] = _canonical({"seq": seq, "key": key, "sha": digest})
    projection = PodAdkSessionProjection(owner_id="owner", hushh_id="HA1fixture", log=log)
    observed_seq, entries = await projection.snapshot()
    assert observed_seq == 10001
    assert entries == {
        ("one", "fixture"): {"revision": 1, "deleted": True, "session_id": "fixture"}
    }
    assert (
        store.get.await_count == 10001
    )  # Verification visits every link without retaining the chain.


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
