import asyncio
import json
from types import SimpleNamespace

import pytest
from google.adk.sessions import Session

from hushh_mcp.one_adk import mcp_pending_call
from hushh_mcp.one_adk.mcp_pending_call import capture_pending_call, restore_pending_call
from hushh_mcp.one_adk.request_secrets import store_request_secret
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError


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
def test_pending_handle_is_owner_thread_app_bound(owner, thread, app):
    handle = capture_pending_call(
        context(), tool_name="mcp_" + "a" * 40, arguments={"q": "private"}
    )
    with pytest.raises(ActionDirectiveAuthorityError):
        restore_pending_call(Session(id=thread, user_id=owner, app_name=app), handle)


@pytest.mark.parametrize("handle", ["literal", "one_secret_ref:expired", ""])
def test_lost_pending_handle_fails_closed(handle):
    with pytest.raises(ActionDirectiveAuthorityError):
        restore_pending_call(Session(id="thread", user_id="owner", app_name="hussh_one"), handle)


def test_missing_native_pending_call_is_not_invented():
    handle = capture_pending_call(
        context(), tool_name="mcp_" + "a" * 40, arguments={"q": "private"}
    )
    with pytest.raises(ActionDirectiveAuthorityError):
        restore_pending_call(Session(id="thread", user_id="owner", app_name="hussh_one"), handle)


@pytest.mark.parametrize("args", [{"q": "x" * 33_000}, {"q": float("nan")}, []])
def test_pending_argument_capture_is_bounded(args):
    with pytest.raises(ActionDirectiveAuthorityError):
        capture_pending_call(context(), tool_name="mcp_" + "a" * 40, arguments=args)


async def test_resume_handle_is_task_local_and_cleared_after_failure(monkeypatch):
    seen = []

    def restore(session, handle):
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
                mcp_pending_call.restore_current_pending_call(
                    Session(id="thread", user_id="a", app_name="hussh_one")
                )
                raise RuntimeError("synthetic cancellation")
        session = Session(id="thread", user_id="outside", app_name="hussh_one")
        assert mcp_pending_call.restore_current_pending_call(session) is session

    async def second():
        await entered.wait()
        reference = store_request_secret(json.dumps({"pendingHandle": "second"}))
        async with mcp_pending_call.pending_resume_scope(reference):
            mcp_pending_call.restore_current_pending_call(
                Session(id="thread", user_id="b", app_name="hussh_one")
            )
        release.set()

    await asyncio.gather(first(), second())
    assert seen == [("b", "second"), ("a", "first")]
