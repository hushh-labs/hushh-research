"""Owner-bound specialist history uses the real encrypted pod log."""

import json
import subprocess
import sys
import textwrap
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.pod_agent_chat_store import PodAgentChatStore, PodAgentChatStoreError
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog, PodLogFenced

UID = "synthetic-firebase-owner"
HUSSH = "ha1_synthetic-owner"
KEY = b"k" * 32


def make_store(path, *, access=None, agent="location"):
    log = PodCommitLog(LocalObjectStore(str(path)), KEY, owner_id=HUSSH)
    access = access if access is not None else AsyncMock(return_value=None)
    store = PodAgentChatStore(
        owner_user_id=UID,
        hushh_id=HUSSH,
        log=log,
        require_access=access,
        agent_id=agent,
        model="synthetic-model",
    )
    return store, log, access


@pytest.mark.asyncio
async def test_process_restart_preserves_order_status_metadata_and_encrypted_storage(tmp_path):
    store, log, _ = make_store(tmp_path)
    first = await store.prepare_turn(user_id=UID, message="synthetic private question")
    assert first.history == []
    metadata = {"choice": {"value": "synthetic private answer"}}
    answer = await store.add_message(
        user_id=UID,
        conversation_id=first.conversation_id,
        role="assistant",
        content="synthetic private answer",
        status="interrupted",
        metadata=metadata,
    )
    metadata["choice"]["value"] = "mutated"
    # A separate interpreter proves recovery does not depend on process caches.
    script = textwrap.dedent("""
        import asyncio, json, sys
        from hushh_mcp.services.pod_agent_chat_store import PodAgentChatStore
        from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
        async def allow():
            pass
        async def run():
            log = PodCommitLog(LocalObjectStore(sys.argv[1]), b"k" * 32,
                               owner_id="ha1_synthetic-owner")
            store = PodAgentChatStore(owner_user_id="synthetic-firebase-owner",
                hushh_id="ha1_synthetic-owner", log=log, require_access=allow,
                agent_id="location", model="synthetic-model")
            turn = await store.prepare_turn(user_id="synthetic-firebase-owner",
                conversation_id=sys.argv[2], message="followup")
            recent = await store.get_recent_messages(sys.argv[2],
                user_id="synthetic-firebase-owner", limit=2)
            print(json.dumps({"history_ids": [m.id for m in turn.history],
                "status": turn.history[1].status, "metadata": turn.history[1].metadata,
                "recent_ids": [m.id for m in recent], "followup_id": turn.user_message_id}))
        asyncio.run(run())
    """)
    completed = subprocess.run(  # noqa: S603 -- trusted interpreter and synthetic fixture
        [sys.executable, "-c", script, str(tmp_path), first.conversation_id],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    recovered = json.loads(completed.stdout)
    assert recovered["history_ids"] == [first.user_message_id, answer.id]
    assert recovered["status"] == "interrupted"
    assert recovered["metadata"] == {"choice": {"value": "synthetic private answer"}}
    assert recovered["recent_ids"] == [answer.id, recovered["followup_id"]]
    assert len(await log.replay()) == 3
    for path in tmp_path.rglob("*"):
        if path.is_file():
            assert b"synthetic private" not in path.read_bytes()


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["prepare", "read", "add"])
async def test_foreign_owner_rejected_before_any_storage_or_callback(tmp_path, operation):
    store, log, access = make_store(tmp_path)
    log.require_open = AsyncMock()
    log.replay = AsyncMock()
    log.append = AsyncMock()
    with pytest.raises(PodAgentChatStoreError, match="owner mismatch"):
        if operation == "prepare":
            await store.prepare_turn(user_id="foreign", message="private")
        elif operation == "read":
            await store.get_recent_messages("conversation", user_id="foreign")
        else:
            await store.add_message(
                user_id="foreign",
                conversation_id="conversation",
                role="assistant",
                content="private",
                status="complete",
            )
    access.assert_not_awaited()
    log.require_open.assert_not_awaited()
    log.replay.assert_not_awaited()
    log.append.assert_not_awaited()


@pytest.mark.asyncio
async def test_revoked_access_has_no_storage_reads_or_writes(tmp_path):
    store, log, _ = make_store(tmp_path, access=AsyncMock(side_effect=PermissionError("revoked")))
    log.require_open = AsyncMock()
    log.replay = AsyncMock()
    log.append = AsyncMock()
    with pytest.raises(PermissionError):
        await store.prepare_turn(user_id=UID, message="private")
    log.require_open.assert_not_awaited()
    log.replay.assert_not_awaited()
    log.append.assert_not_awaited()


@pytest.mark.asyncio
async def test_real_fence_refuses_warm_and_restarted_store(tmp_path):
    store, log, _ = make_store(tmp_path)
    first = await store.prepare_turn(user_id=UID, message="private")
    await log.fence_for_erasure(owner_id=HUSSH, attempt_id="synthetic-erasure-attempt")
    restarted, _, _ = make_store(tmp_path)
    for adapter in (store, restarted):
        with pytest.raises(PodLogFenced):
            await adapter.get_recent_messages(first.conversation_id, user_id=UID)
        with pytest.raises(PodLogFenced):
            await adapter.prepare_turn(user_id=UID, message="private")


@pytest.mark.asyncio
async def test_failed_append_has_no_ghost_message(tmp_path):
    store, log, _ = make_store(tmp_path)
    first = await store.prepare_turn(user_id=UID, message="first")
    original = log.append
    log.append = AsyncMock(side_effect=RuntimeError("private-provider-sentinel"))
    with pytest.raises(PodAgentChatStoreError, match="^Pod chat append unavailable$"):
        await store.add_message(
            user_id=UID,
            conversation_id=first.conversation_id,
            role="assistant",
            content="never committed",
            status="error",
        )
    log.append = original
    restarted, _, _ = make_store(tmp_path)
    for adapter in (store, restarted):
        history = await adapter.get_recent_messages(first.conversation_id, user_id=UID)
        assert [item.id for item in history] == [first.user_message_id]


@pytest.mark.asyncio
async def test_specialist_conversation_namespace(tmp_path):
    location, _, _ = make_store(tmp_path)
    first = await location.prepare_turn(user_id=UID, message="location context")
    email, _, _ = make_store(tmp_path, agent="email")
    assert await email.get_recent_messages(first.conversation_id, user_id=UID) == []
    separate = await email.prepare_turn(
        user_id=UID, message="email", conversation_id=first.conversation_id
    )
    assert separate.conversation_id == first.conversation_id
    assert separate.history == []
    assert [
        m.content for m in await location.get_recent_messages(first.conversation_id, user_id=UID)
    ] == ["location context"]
    assert [
        m.content for m in await email.get_recent_messages(first.conversation_id, user_id=UID)
    ] == ["email"]


@pytest.mark.parametrize("owner", [None, UID, "foreign"])
def test_constructor_refuses_unbound_or_wrong_log_owner(tmp_path, owner):
    log = PodCommitLog(LocalObjectStore(str(tmp_path)), KEY, owner_id=owner)
    with pytest.raises(PodAgentChatStoreError, match="binding invalid"):
        PodAgentChatStore(
            owner_user_id=UID,
            hushh_id=HUSSH,
            log=log,
            require_access=AsyncMock(),
            agent_id="location",
            model="synthetic",
        )


@pytest.mark.asyncio
async def test_revocation_during_replay_refuses_history_release(tmp_path):
    store, log, access = make_store(tmp_path)
    first = await store.prepare_turn(user_id=UID, message="private")
    original = log.replay

    async def revoke_after_read():
        records = await original()
        access.side_effect = PermissionError("revoked")
        return records

    log.replay = revoke_after_read
    with pytest.raises(PermissionError):
        await store.get_recent_messages(first.conversation_id, user_id=UID)
