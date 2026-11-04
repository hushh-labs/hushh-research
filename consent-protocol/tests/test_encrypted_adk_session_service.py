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
    shared_outbox = AsyncMock(side_effect=AssertionError("Private session reached shared outbox"))
    monkeypatch.setattr(
        "hushh_mcp.one_adk.adk_session_repository._replace_with_reply_usage", shared_outbox
    )
    service = EncryptedAdkSessionService(
        static_chat_cipher(), repository=repository, referral_usage_app_name="one"
    )
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

    phases = []
    monkeypatch.setattr(service, "_record_phase", lambda phase, _started: phases.append(phase))
    repository.replace = AsyncMock(return_value=SimpleNamespace(data=[{"revision": 2}]))
    await service.append_event(restored, Event(author="one", timestamp=1.0))
    assert phases == ["append", "persistence"]
    replaced = repository.replace.call_args.kwargs
    assert replaced["user"] == "owner" and replaced["session"] == "thread"
    assert "synthetic private note" not in str(replaced)

    await service.append_event(
        restored,
        Event(
            author="user",
            timestamp=3.0,
            invocation_id="private-turn",
            content=types.Content(role="user", parts=[types.Part(text="synthetic private prompt")]),
        ),
    )
    await service.append_event(
        restored,
        Event(
            author="one",
            timestamp=4.0,
            invocation_id="private-turn",
            content=types.Content(role="model", parts=[types.Part(text="synthetic private reply")]),
        ),
    )
    assert "reply_usage" not in repository.replace.call_args.kwargs
    shared_outbox.assert_not_awaited()

    phases.clear()
    repository.replace.side_effect = RuntimeError("synthetic persistence failure")
    with pytest.raises(RuntimeError, match="synthetic persistence failure"):
        await service.append_event(restored, Event(author="one", timestamp=2.0))
    assert phases == ["append", "persistence"]


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
    # Turn completion checkpoints even a short tail below the periodic interval.
    with monkeypatch.context() as patch:
        patch.setattr(pod_adk_checkpoint, "INTERVAL", 10000)
        await log.append("unrelated", {"synthetic": True})
        await restarted_repo._projection.snapshot(force_save=True)
        assert restarted_repo._projection._checkpoint_seq == restarted_repo._projection._cursor.seq
    # A lost optimization write cannot erase the authoritative conversation.
    with monkeypatch.context() as patch:
        from unittest.mock import AsyncMock

        patch.setattr(log._store, "put_if_generation", AsyncMock(side_effect=OSError("synthetic")))
        seq, entries = await restarted_repo._projection.snapshot(force_save=True)
        assert seq and entries and not restarted_repo._projection._loaded
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
    # Erasure can race after a valid projection read; a warm result must still
    # pass the final log fence before leaving the request-bound repository.
    snapshot = restarted_repo._projection.snapshot

    async def erased_after_snapshot():
        result = await snapshot()
        await log.fence_for_erasure(owner_id="HA1fixture", attempt_id="fixture-erasure")
        return result

    with monkeypatch.context() as patch:
        patch.setattr(restarted_repo._projection, "snapshot", erased_after_snapshot)
        with pytest.raises(PodLogFenced):
            await restarted.get_session(**identity)
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
        get_bounded_with_generation=AsyncMock(side_effect=lambda key, **_: (objects.get(key), "1")),
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


def _stm_events(count=7, width=20):
    return [
        Event(
            id=f"event-{index}-{role}",
            author=author,
            invocation_id=f"turn-{index}",
            content=types.Content(
                role=role, parts=[types.Part(text=f"{index} {role} " + "x" * width)]
            ),
        )
        for index in range(count)
        for role, author in (("user", "user"), ("model", "one"))
    ]


def test_stm_counts_system_tools_and_ltm_and_never_cuts_a_tool_pair():
    from google.adk.models.llm_request import LlmRequest

    from hushh_mcp.one_adk.chat_memory import (
        ContextBudget,
        estimate_request_tokens,
        fit_recent_context,
    )

    request = LlmRequest(
        model="fixture",
        contents=[
            types.Content(role="user", parts=[types.Part(text="old " * 100)]),
            types.Content(
                role="model",
                parts=[types.Part(function_call=types.FunctionCall(name="read", args={}))],
            ),
            types.Content(
                role="user",
                parts=[
                    types.Part(
                        function_response=types.FunctionResponse(name="read", response={"ok": True})
                    )
                ],
            ),
            types.Content(role="user", parts=[types.Part(text="newest")]),
        ],
        config=types.GenerateContentConfig(
            system_instruction="LTM packet " * 10,
            tools=[
                types.Tool(
                    function_declarations=[
                        types.FunctionDeclaration(name="read", description="schema")
                    ]
                )
            ],
        ),
    )
    full = estimate_request_tokens(request)
    no_config = request.model_copy(update={"config": types.GenerateContentConfig()})
    assert full > estimate_request_tokens(no_config)
    fit_recent_context(request, ContextBudget(500, 100), summary_applied=False)
    assert [part.text for content in request.contents for part in content.parts] == ["newest"]


def test_stm_snapshot_rolls_forward_and_excludes_consent_tagged_turns():
    from hushh_mcp.one_adk import chat_memory as stm
    from hushh_mcp.one_adk.consent_redaction import consent_invocations_state_key

    session = Session(id="s", app_name="one", user_id="owner", events=_stm_events())
    session.state[consent_invocations_state_key("bundle")] = ["turn-1"]
    first = stm.summary_snapshot(session)
    assert first and all(not row["content"].startswith("1 ") for row in first["messages"])
    checkpoint = {key: first[key] for key in ("version", "cutoff", "prefixDigest", "consentDigest")}
    checkpoint["summary"] = "Kept the earlier owner context."
    session.state[stm.CHECKPOINT_KEY] = checkpoint
    session.events.extend(_stm_events(9)[14:])
    second = stm.summary_snapshot(session)
    assert second["previousSummary"] == checkpoint["summary"]
    assert second["cutoff"] != first["cutoff"]
    assert all(not row["content"].startswith("0 ") for row in second["messages"])
    # A newly tagged old turn invalidates the prior untagged summary.
    session.state[consent_invocations_state_key("bundle")] = ["turn-0", "turn-1"]
    assert stm.checkpoint_prefix(session, checkpoint) is None


@pytest.mark.asyncio
async def test_stm_summary_commit_keeps_arrivals_and_fences_stale_summary(monkeypatch):
    from hushh_mcp.one_adk import chat_memory as stm

    service = EncryptedAdkSessionService(static_chat_cipher())
    rows = _Rows()
    monkeypatch.setattr(service, "_execute", rows.execute)
    identity = {"app_name": "one", "user_id": "owner", "session_id": "stm-thread"}
    session = await service.create_session(**identity)
    for event in _stm_events():
        await service.append_event(session, event)
    snapshot = stm.summary_snapshot(session)
    checkpoint = {
        key: snapshot[key] for key in ("version", "cutoff", "prefixDigest", "consentDigest")
    }
    checkpoint["summary"] = "Synthetic summarized owner context."
    # An arrival wins the storage CAS between the summary's read and write.
    arrival = _stm_events(8)[14]
    original_replace = service._repository.replace
    raced = False

    async def replace_with_arrival(**kwargs):
        nonlocal raced
        if not raced:
            raced = True
            await service.append_event(session, arrival)
        return await original_replace(**kwargs)

    monkeypatch.setattr(service._repository, "replace", replace_with_arrival)
    assert await service.commit_chat_summary(
        **identity, expected_checkpoint=None, checkpoint=checkpoint
    )
    restored = await service.get_session(**identity)
    assert len(restored.events) == 15 and restored.events[-1].id == arrival.id
    assert restored.state[stm.CHECKPOINT_KEY] == checkpoint
    assert checkpoint["summary"] not in str(rows.rows)
    # A stale model result cannot replace a newer checkpoint.
    stale = {**checkpoint, "summary": "Stale replacement"}
    assert not await service.commit_chat_summary(
        **identity, expected_checkpoint=None, checkpoint=stale
    )
    assert (await service.get_session(**identity)).state[stm.CHECKPOINT_KEY] == checkpoint


@pytest.mark.asyncio
async def test_stm_background_failure_never_waits_or_advances_checkpoint(monkeypatch):
    from unittest.mock import AsyncMock

    from google.adk.models.llm_request import LlmRequest

    from hushh_mcp.one_adk import chat_memory as stm
    from hushh_mcp.one_adk.agui_turn_timing import _CURRENT_TURN, TurnTiming

    session = Session(id="s", app_name="one", user_id="owner", events=_stm_events(width=1000))
    service = SimpleNamespace(commit_chat_summary=AsyncMock())
    started, release = asyncio.Event(), asyncio.Event()

    async def failing(**_kwargs):
        started.set()
        await release.wait()
        raise ValueError("synthetic failed summary")

    monkeypatch.setattr(stm, "generate_summary", failing)
    monkeypatch.setattr(stm, "context_budget", lambda _: stm.ContextBudget(8000, 1000))
    context = SimpleNamespace(
        session=session,
        state=session.state,
        invocation_id="new-turn",
        get_invocation_context=lambda: SimpleNamespace(
            session=session, session_service=service, agent=SimpleNamespace(model=object())
        ),
    )
    request = LlmRequest(model="fixture", contents=[event.content for event in session.events])
    timing = TurnTiming(head="one", run="fixture", started_at=0)
    token = _CURRENT_TURN.set(timing)
    try:
        # Returns synchronously; the provider coroutine has not even started.
        stm.chat_memory_before_model(context, request)
        assert not started.is_set()
        assert stm.CHECKPOINT_KEY not in session.state
        assert len(request.contents) < len(session.events)
        assert len(session.events) == 14
        await started.wait()
        assert len(stm._PENDING) == 1
        # Same conversation cannot spawn a second competing summary.
        stm.chat_memory_before_model(context, request)
        assert len(stm._PENDING) == 1
        release.set()
        await asyncio.gather(*stm._PENDING.values())
        await asyncio.sleep(0)
        assert not stm._PENDING
        service.commit_chat_summary.assert_not_awaited()
        assert stm.CHECKPOINT_KEY not in session.state
        usage = timing.context_usage_events[-1]
        assert usage["tokenCountMethod"] == "conservative_utf8_bytes"
        response = SimpleNamespace(
            partial=False, usage_metadata=SimpleNamespace(prompt_token_count=321)
        )
        stm.chat_memory_after_model(context, response)
        actual = timing.context_usage_events[-1]
        assert actual["modelCallId"] == usage["modelCallId"]
        assert actual["inputTokens"] == 321 and actual["tokenCountMethod"] == "provider_usage"
    finally:
        release.set()
        for task in list(stm._PENDING.values()):
            task.cancel()
        if stm._PENDING:
            await asyncio.gather(*stm._PENDING.values(), return_exceptions=True)
        _CURRENT_TURN.reset(token)


@pytest.mark.asyncio
async def test_stm_owner_model_gene_and_encrypted_checkpoint_cover_only_snapshot(monkeypatch):
    import json
    from unittest.mock import AsyncMock

    from google.adk.models.base_llm import BaseLlm
    from google.adk.models.llm_response import LlmResponse

    from hushh_mcp.one_adk import chat_memory as stm

    requests = []
    gate = asyncio.Event()

    class OwnerModel(BaseLlm):
        async def generate_content_async(self, llm_request, stream=False):
            requests.append(llm_request)
            await gate.wait()
            text = llm_request.contents[-1].parts[0].text
            payload = json.loads(text)
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            text=json.dumps(
                                {
                                    "summary": "Earlier owner goals and decisions.",
                                    "cutoff": payload["cutoff"],
                                }
                            )
                        )
                    ],
                )
            )

    service = EncryptedAdkSessionService(static_chat_cipher())
    rows = _Rows()
    monkeypatch.setattr(service, "_execute", rows.execute)
    identity = {"app_name": "one", "user_id": "owner", "session_id": "gene-thread"}
    session = await service.create_session(**identity)
    for event in _stm_events():
        await service.append_event(session, event)
    snapshot = stm.summary_snapshot(session)
    job = asyncio.create_task(
        stm._summarize(service, identity, OwnerModel(model="fixture"), snapshot)
    )
    try:
        for _ in range(100):
            if requests:
                break
            await asyncio.sleep(0.01)
        assert requests, "summary must execute the supplied owner model through the real ADK gene"
        arrival = _stm_events(8)[14]
        await service.append_event(session, arrival)
        gate.set()
        await job
        restored = await service.get_session(**identity)
        checkpoint = restored.state[stm.CHECKPOINT_KEY]
        assert checkpoint["cutoff"] == snapshot["cutoff"]
        assert restored.events[-1].id == arrival.id
        request = SimpleNamespace(contents=[event.content for event in restored.events])
        assert stm._apply_checkpoint(request, restored)
        texts = [part.text for content in request.contents for part in content.parts]
        assert texts[0].endswith(checkpoint["summary"])
        assert texts[-1] == arrival.content.parts[0].text
        assert all(not text.startswith("0 ") for text in texts)
        assert all(any(text.startswith(f"{turn} ") for text in texts) for turn in range(3, 8))
        # A provider failure preserves the previous summary and its exact cutoff.
        monkeypatch.setattr(stm, "generate_summary", AsyncMock(side_effect=ValueError("failed")))
        next_snapshot = stm.summary_snapshot(restored)
        assert next_snapshot
        await stm._summarize(service, identity, OwnerModel(model="fixture"), next_snapshot)
        assert (await service.get_session(**identity)).state[stm.CHECKPOINT_KEY] == checkpoint
    finally:
        gate.set()
        if not job.done():
            job.cancel()
        await asyncio.gather(job, return_exceptions=True)


def test_stm_never_swallows_queued_or_resumed_messages_from_a_covered_invocation():
    from hushh_mcp.one_adk import chat_memory as stm

    session = SimpleNamespace(events=_stm_events(), state={})
    # A queued user input shares the previous turn's invocation. Keep that
    # whole invocation verbatim rather than splitting at the queued message.
    session.events[6].invocation_id = session.events[4].invocation_id
    snapshot = stm.summary_snapshot(session)
    assert snapshot["cutoff"] == session.events[3].id
    checkpoint = {
        key: snapshot[key] for key in ("version", "cutoff", "prefixDigest", "consentDigest")
    }
    checkpoint["summary"] = "Previously validated summary."
    assert stm.checkpoint_prefix(session, checkpoint) is not None
    # A late resumption with the covered invocation invalidates application;
    # no newer message can disappear just because its invocation matches.
    arrival = _stm_events(8)[14]
    arrival.invocation_id = session.events[0].invocation_id
    session.events.append(arrival)
    assert stm.checkpoint_prefix(session, checkpoint) is None


def test_stm_uses_documented_model_window_and_calibrates_whole_request():
    from google.adk.models.llm_request import LlmRequest

    from hushh_mcp.one_adk import chat_memory as stm

    assert stm.context_budget("gemini-3.8-flash").context == 1048576
    assert stm.context_budget("gpt-5.1").context == 400000
    assert stm.context_budget("gpt-6-luna").context == 1050000
    assert stm.context_budget("unknown-local").kind == "unknown_model_fallback"
    request = LlmRequest(
        model="gemini-3.8-flash",
        contents=[types.Content(role="user", parts=[types.Part(text="a message")])],
    )
    state = {stm._CALIBRATION_KEY: {"model": request.model, "bytes": 10000, "tokens": 3000}}
    assert stm._calibration_ratio(request, state) == pytest.approx(0.345)
    state[stm._CALIBRATION_KEY]["model"] = "other-model"
    assert stm._calibration_ratio(request, state) == 1.0
