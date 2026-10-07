import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from google.adk.sessions import Session

from db.db_client import DatabaseExecutionError
from hushh_mcp.one_adk import mcp_pending_call, request_secrets
from hushh_mcp.one_adk.mcp_pending_call import (
    PendingCallStorageError,
    capture_pending_call,
    pending_call_details,
    restore_pending_call,
)
from hushh_mcp.one_adk.request_secrets import store_request_secret
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from hushh_mcp.services.chat_key import ChatKeyUnavailableError
from tests.helpers.chat_keys import OTHER_CHAT_KEY, static_chat_cipher

pytestmark = pytest.mark.usefixtures("shared_pending_store")

TOOL = "mcp_" + "a" * 40


def context():
    return SimpleNamespace(
        user_id="owner",
        function_call_id="call",
        state={
            "hussh:user_id": "owner",
            "hussh:conversation_id": "thread",
        },
    )


@pytest.mark.parametrize(
    "owner,thread,app",
    [
        ("other", "thread", "hussh_one"),
        ("owner", "other", "hussh_one"),
        ("owner", "thread", "other"),
    ],
)
async def test_pending_handle_is_owner_thread_app_bound(owner, thread, app):
    handle = await capture_pending_call(context(), tool_name=TOOL, arguments={"q": "private"})
    with pytest.raises(ActionDirectiveAuthorityError):
        await restore_pending_call(Session(id=thread, user_id=owner, app_name=app), handle)


@pytest.mark.parametrize("handle", ["literal", "one_secret_ref:expired", ""])
async def test_lost_pending_handle_fails_closed(handle):
    with pytest.raises(ActionDirectiveAuthorityError):
        await restore_pending_call(
            Session(id="thread", user_id="owner", app_name="hussh_one"), handle
        )


async def test_missing_native_pending_call_is_not_invented():
    handle = await capture_pending_call(context(), tool_name=TOOL, arguments={"q": "private"})
    with pytest.raises(ActionDirectiveAuthorityError):
        await restore_pending_call(
            Session(id="thread", user_id="owner", app_name="hussh_one"), handle
        )


@pytest.mark.parametrize("args", [{"q": "x" * 33_000}, {"q": float("nan")}, []])
async def test_pending_argument_capture_is_bounded(args):
    with pytest.raises(ActionDirectiveAuthorityError):
        await capture_pending_call(context(), tool_name=TOOL, arguments=args)


async def test_resume_handle_is_task_local_and_cleared_after_failure(monkeypatch):
    seen = []

    async def restore(session, handle):
        seen.append((session.user_id, handle))
        return session

    monkeypatch.setattr(mcp_pending_call, "restore_pending_call", restore)
    entered = asyncio.Event()
    release = asyncio.Event()

    async def first():
        reference = store_request_secret(json.dumps({"pendingHandle": "first"}))
        with pytest.raises(RuntimeError):
            async with mcp_pending_call.pending_resume_scope(reference):
                entered.set()
                await release.wait()
                await mcp_pending_call.restore_current_pending_call(
                    Session(id="thread", user_id="a", app_name="hussh_one")
                )
                raise RuntimeError("synthetic cancellation")
        session = Session(id="thread", user_id="outside", app_name="hussh_one")
        assert await mcp_pending_call.restore_current_pending_call(session) is session

    async def second():
        await entered.wait()
        reference = store_request_secret(json.dumps({"pendingHandle": "second"}))
        async with mcp_pending_call.pending_resume_scope(reference):
            await mcp_pending_call.restore_current_pending_call(
                Session(id="thread", user_id="b", app_name="hussh_one")
            )
        release.set()

    await asyncio.gather(first(), second())
    assert seen == [("b", "second"), ("a", "first")]


def session(user="owner", thread="thread"):
    return Session(id=thread, user_id=user, app_name="hussh_one")


async def test_review_survives_a_different_instance(shared_pending_store):
    """The failure seen on UAT: another instance served the approval.

    Process memory (the request-secret map) is private to an instance. A review
    issued on one and decided on another must still open.
    """
    handle = await capture_pending_call(context(), tool_name=TOOL, arguments={"q": "private"})
    request_secrets._values.clear()
    pending = await pending_call_details(session(), handle)
    assert pending["arguments"] == {"q": "private"}
    assert pending["call_id"] == "call"
    assert pending["tool_name"] == TOOL


async def test_pending_arguments_are_sealed_at_rest(shared_pending_store):
    await capture_pending_call(
        context(), tool_name=TOOL, arguments={"q": "PRIVATE_REVIEW_ARGUMENT"}
    )
    (row,) = shared_pending_store.rows.values()
    stored = json.dumps({key: value for key, value in row.items() if key.startswith("payload_")})
    assert "PRIVATE_REVIEW_ARGUMENT" not in stored
    assert row["payload_ciphertext"].startswith("hussh-chat-v1:")


async def test_pending_call_does_not_open_under_another_key(monkeypatch):
    handle = await capture_pending_call(context(), tool_name=TOOL, arguments={"q": "private"})
    monkeypatch.setattr(mcp_pending_call, "ChatCipher", lambda: static_chat_cipher(OTHER_CHAT_KEY))
    with pytest.raises(ActionDirectiveAuthorityError):
        await pending_call_details(session(), handle)


async def test_pending_call_needs_the_owners_key_to_open_or_store(monkeypatch):
    handle = await capture_pending_call(context(), tool_name=TOOL, arguments={"q": "private"})

    class Locked:
        def seal(self, *_args, **_kwargs):
            raise ChatKeyUnavailableError("locked")

        open = seal

    monkeypatch.setattr(mcp_pending_call, "ChatCipher", Locked)
    # A locked vault is not an expired review: the chat-key refusal reaches the person.
    with pytest.raises(ChatKeyUnavailableError):
        await pending_call_details(session(), handle)
    with pytest.raises(PendingCallStorageError):
        await capture_pending_call(context(), tool_name=TOOL, arguments={"q": "private"})


async def test_expired_pending_call_does_not_open(shared_pending_store):
    handle = await capture_pending_call(context(), tool_name=TOOL, arguments={"q": "private"})
    (row,) = shared_pending_store.rows.values()
    row["expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    with pytest.raises(ActionDirectiveAuthorityError):
        await pending_call_details(session(), handle)


async def test_pending_call_lapses_with_its_review(shared_pending_store):
    review = {"expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()}
    await capture_pending_call(context(), tool_name=TOOL, arguments={}, review=review)
    (row,) = shared_pending_store.rows.values()
    remaining = row["expires_at"] - datetime.now(timezone.utc)
    # Exactly the review's own lifetime: the ledger refuses an expired directive, so a
    # longer-lived record would only keep sealed arguments that can never be used.
    assert timedelta(minutes=4, seconds=50) < remaining <= timedelta(minutes=5)


@pytest.mark.parametrize(
    "review",
    [None, {}, {"expiresAt": "garbage"}, {"expiresAt": "2099-01-01T00:00:00"}],
    ids=["none", "empty", "unparseable", "naive"],
)
async def test_unusable_review_expiry_falls_back_to_the_cap(shared_pending_store, review):
    await capture_pending_call(context(), tool_name=TOOL, arguments={}, review=review)
    (row,) = shared_pending_store.rows.values()
    remaining = row["expires_at"] - datetime.now(timezone.utc)
    assert timedelta(minutes=19) < remaining <= timedelta(minutes=20)


async def test_far_future_review_expiry_is_capped(shared_pending_store):
    review = {"expiresAt": "2099-01-01T00:00:00+00:00"}
    await capture_pending_call(context(), tool_name=TOOL, arguments={}, review=review)
    (row,) = shared_pending_store.rows.values()
    assert row["expires_at"] - datetime.now(timezone.utc) <= timedelta(minutes=20)


async def test_capture_purges_the_owners_lapsed_rows(shared_pending_store):
    first = await capture_pending_call(context(), tool_name=TOOL, arguments={})
    (row,) = shared_pending_store.rows.values()
    row["expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    await capture_pending_call(context(), tool_name=TOOL, arguments={})
    assert ("owner", first) not in shared_pending_store.rows
    assert len(shared_pending_store.rows) == 1


async def test_storage_failure_never_exposes_sql_or_values(monkeypatch):
    def fail(*_args, **_kwargs):
        raise DatabaseExecutionError(
            table_name="<raw_sql>",
            operation="execute_raw",
            details="INSERT INTO one_mcp_pending_calls [parameters: PRIVATE_REVIEW_ARGUMENT]",
        )

    monkeypatch.setattr(mcp_pending_call, "get_db", lambda: SimpleNamespace(execute_raw=fail))
    with pytest.raises(PendingCallStorageError) as caught:
        await capture_pending_call(
            context(), tool_name=TOOL, arguments={"q": "PRIVATE_REVIEW_ARGUMENT"}
        )
    assert str(caught.value) == "Connector review is temporarily unavailable."


def _refusal_logs(caplog):
    return [
        record.getMessage()
        for record in caplog.records
        if record.name == mcp_pending_call.logger.name
    ]


async def test_missing_pending_record_logs_a_reason_and_nothing_private(
    caplog, shared_pending_store
):
    handle = await capture_pending_call(
        context(), tool_name=TOOL, arguments={"q": "private-argument-value"}
    )
    shared_pending_store.rows.clear()  # the record is gone: past its lifetime or removed
    with caplog.at_level(logging.WARNING, logger=mcp_pending_call.logger.name):
        with pytest.raises(ActionDirectiveAuthorityError) as refused:
            await restore_pending_call(
                Session(id="thread", user_id="owner", app_name="hussh_one"), handle
            )
    assert str(refused.value) == "Connector review expired. Review again."
    assert refused.value.reason == "pending_handle_missing"
    assert _refusal_logs(caplog) == ["one.mcp_review_refused reason=pending.handle.missing"]
    assert handle not in caplog.text and "private-argument-value" not in caplog.text


@pytest.mark.parametrize(
    "owner,thread,app,reason",
    [
        ("other", "thread", "hussh_one", "pending_handle_missing"),
        ("owner", "other", "hussh_one", "pending_handle_missing"),
        ("owner", "thread", "x", "binding_mismatch"),
    ],
)
async def test_pending_binding_mismatch_logs_its_reason(caplog, owner, thread, app, reason):
    handle = await capture_pending_call(
        context(), tool_name=TOOL, arguments={"q": "private-argument-value"}
    )
    with caplog.at_level(logging.WARNING, logger=mcp_pending_call.logger.name):
        with pytest.raises(ActionDirectiveAuthorityError):
            await restore_pending_call(Session(id=thread, user_id=owner, app_name=app), handle)
    assert _refusal_logs(caplog) == [f"one.mcp_review_refused reason={reason.replace('_', '.')}"]
    assert "private-argument-value" not in caplog.text and handle not in caplog.text


async def test_unreadable_pending_record_logs_its_reason(caplog, monkeypatch):
    handle = await capture_pending_call(context(), tool_name=TOOL, arguments={})
    monkeypatch.setattr(mcp_pending_call, "ChatCipher", lambda: static_chat_cipher(OTHER_CHAT_KEY))
    with caplog.at_level(logging.WARNING, logger=mcp_pending_call.logger.name):
        with pytest.raises(ActionDirectiveAuthorityError) as refused:
            await pending_call_details(session(), handle)
    assert refused.value.reason == "pending_record_unreadable"
    assert _refusal_logs(caplog) == ["one.mcp_review_refused reason=pending.record.unreadable"]


def approval_reference(handle, owner="owner", thread="thread"):
    return store_request_secret(
        json.dumps({"pendingHandle": handle, "owner": owner, "thread": thread})
    )


async def test_the_record_is_removed_once_the_resumed_turn_completes(shared_pending_store):
    handle = await capture_pending_call(context(), tool_name=TOOL, arguments={"q": "private"})
    async with mcp_pending_call.pending_resume_scope(approval_reference(handle)):
        # Every session read inside the turn still needs it.
        assert (await pending_call_details(session(), handle))["arguments"] == {"q": "private"}
        assert len(shared_pending_store.rows) == 1
    assert shared_pending_store.rows == {}


@pytest.mark.parametrize("failure", [RuntimeError, asyncio.CancelledError])
async def test_a_failed_or_cancelled_turn_leaves_the_record_to_its_expiry(
    shared_pending_store, failure
):
    handle = await capture_pending_call(context(), tool_name=TOOL, arguments={"q": "private"})
    with pytest.raises(failure):
        async with mcp_pending_call.pending_resume_scope(approval_reference(handle)):
            raise failure()
    assert len(shared_pending_store.rows) == 1


async def test_a_scope_without_a_handle_deletes_nothing(shared_pending_store):
    await capture_pending_call(context(), tool_name=TOOL, arguments={})
    async with mcp_pending_call.pending_resume_scope(None):
        pass
    assert len(shared_pending_store.rows) == 1


async def test_discarding_is_bound_to_owner_conversation_and_handle(shared_pending_store):
    handle = await capture_pending_call(context(), tool_name=TOOL, arguments={})
    await mcp_pending_call.discard_pending_call(owner="other", thread="thread", handle=handle)
    await mcp_pending_call.discard_pending_call(owner="owner", thread="other", handle=handle)
    await mcp_pending_call.discard_pending_call(owner="owner", thread="thread", handle="garbage")
    assert len(shared_pending_store.rows) == 1
    await mcp_pending_call.discard_pending_call(owner="owner", thread="thread", handle=handle)
    assert shared_pending_store.rows == {}


async def test_a_storage_failure_while_discarding_never_breaks_the_turn(monkeypatch):
    handle = "one_secret_ref:" + "a" * 32

    def fail(*_args, **_kwargs):
        raise DatabaseExecutionError(table_name="<raw_sql>", operation="execute_raw", details="x")

    monkeypatch.setattr(mcp_pending_call, "get_db", lambda: SimpleNamespace(execute_raw=fail))
    async with mcp_pending_call.pending_resume_scope(approval_reference(handle)):
        pass  # completes; the record simply lapses on its own


async def test_private_pending_scope_keeps_arguments_local_and_never_uses_sql(monkeypatch):
    async def forbidden(*_args, **_kwargs):
        raise AssertionError("Private arguments reached shared SQL")

    monkeypatch.setattr(mcp_pending_call, "_execute", forbidden)
    with mcp_pending_call.private_pending_call_scope():
        handle = await capture_pending_call(context(), tool_name=TOOL, arguments={"q": "private"})
        pending = await pending_call_details(session(), handle)
        assert pending["arguments"] == {"q": "private"}
        with pytest.raises(ActionDirectiveAuthorityError):
            await pending_call_details(session(user="other"), handle)
        await mcp_pending_call.discard_pending_call(owner="other", thread="thread", handle=handle)
        assert (await pending_call_details(session(), handle))["arguments"] == {"q": "private"}
        await mcp_pending_call.discard_pending_call(owner="owner", thread="thread", handle=handle)
        with pytest.raises(ActionDirectiveAuthorityError):
            await pending_call_details(session(), handle)


async def test_pod_process_without_scope_cannot_fall_through_to_sql(monkeypatch):
    async def forbidden(*_args, **_kwargs):
        raise AssertionError("Pod opened shared SQL")

    monkeypatch.setattr(mcp_pending_call, "pod_mode", lambda: True)
    monkeypatch.setattr(mcp_pending_call, "get_db", lambda: pytest.fail("Pod opened shared SQL"))
    monkeypatch.setattr(mcp_pending_call, "_execute", forbidden)
    handle = await capture_pending_call(context(), tool_name=TOOL, arguments={})
    assert (await pending_call_details(session(), handle))["arguments"] == {}
