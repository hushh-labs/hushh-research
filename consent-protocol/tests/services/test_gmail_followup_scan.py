"""Resumable Mail scan: owner/grant fences, retries and unbounded page count."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.gmail_receipts_service import GmailApiError, GmailReceiptsService


@pytest.mark.asyncio
async def test_recent_meeting_failure_preserves_replies_and_reports_its_own_coverage():
    from hushh_mcp.services.gmail_nudges import NudgeMessage, NudgeThread
    from hushh_mcp.services.gmail_token_reads import list_nudges_with_token

    thread = NudgeThread(
        thread_id="thread",
        messages=(
            NudgeMessage(
                message_id="message",
                from_email="ravi@example.com",
                from_name="Ravi",
                subject="Friday demo",
                received_at=datetime.now(timezone.utc),
            ),
        ),
    )
    helper = SimpleNamespace(
        _http_get_json=AsyncMock(return_value={"emailAddress": "owner@example.com"}),
        _list_messages=AsyncMock(return_value={"messages": [{"threadId": "thread"}]}),
        _get_thread_metadata=AsyncMock(return_value=thread),
        _nudge_thread_from_payload=lambda value: value,
        _fetch_meeting_events=AsyncMock(side_effect=RuntimeError("Provider unavailable")),
        _fetch_body_meeting_events=AsyncMock(return_value=[]),
    )
    fixture = "fixture-only"
    result = await list_nudges_with_token(helper, access_token=fixture, user_id="owner", limit=25)
    assert result["nudges"][0]["sender"] == "Ravi"
    assert result["meeting_scan"] == {
        "scope": "recent_invitations_and_mentions",
        "status": "unavailable",
    }


@pytest.mark.asyncio
async def test_followup_scan_reaches_old_threads_after_multiple_provider_pages():
    from hushh_mcp.services.gmail_followup_scan import THREADS_URL, scan_followup_page
    from hushh_mcp.services.gmail_nudges import NudgeMessage, NudgeThread

    pages = [[f"thread-{page}-{item}" for item in range(25)] for page in range(3)]
    listed = []

    async def get_json(url, *, token, params=None):
        if url != THREADS_URL:
            return {"emailAddress": "owner@example.com"}
        page = int((params or {}).get("pageToken", "0"))
        listed.append(page)
        assert "newer_than" not in params["q"] and "category:primary" not in params["q"]
        return {
            "threads": [{"id": key} for key in pages[page]],
            **({"nextPageToken": str(page + 1)} if page < 2 else {}),
        }

    async def metadata(*, access_token, thread_id):
        return NudgeThread(
            thread_id=thread_id,
            messages=(
                NudgeMessage(
                    message_id="message-" + thread_id,
                    from_email="person@example.com",
                    from_name="Person",
                    subject="Please review",
                    received_at=datetime.now(timezone.utc) - timedelta(days=90),
                ),
            ),
        )

    helper = SimpleNamespace(
        _state_secret=lambda: "fixture-only",
        _http_get_json=get_json,
        _get_thread_metadata=metadata,
        _nudge_thread_from_payload=lambda value: value,
    )
    cursor, total = None, []
    for page in range(3):
        result = await scan_followup_page(
            helper,
            access_token=helper._state_secret(),
            user_id="owner",
            binding=["owner", "gmail", "account", "generation"],
            cursor=cursor,
            require_current=AsyncMock(),
        )
        total.extend(result["nudges"])
        cursor = result["next_cursor"]
        assert result["coverage"]["complete"] is (page == 2)
        assert "thread-" not in (cursor or "")
    assert listed == [0, 1, 2] and len(total) == 75 and cursor is None
    assert result["coverage"]["scanned_threads"] == 75


@pytest.mark.asyncio
async def test_followup_scan_retries_failed_threads_and_rejects_foreign_cursors():
    from hushh_mcp.services.gmail_followup_scan import THREADS_URL, scan_followup_page
    from hushh_mcp.services.gmail_nudges import NudgeMessage, NudgeThread

    async def get_json(url, *, token, params=None):
        return (
            {"threads": [{"id": "thread"}]}
            if url == THREADS_URL
            else {"emailAddress": "owner@example.com"}
        )

    metadata = AsyncMock(
        side_effect=[
            RuntimeError("provider failed"),
            NudgeThread(
                thread_id="thread",
                messages=(
                    NudgeMessage(
                        message_id="message",
                        from_email="person@example.com",
                        from_name="Person",
                        subject="Review",
                        received_at=datetime.now(timezone.utc),
                    ),
                ),
            ),
        ]
    )
    helper = SimpleNamespace(
        _state_secret=lambda: "fixture-only",
        _http_get_json=AsyncMock(side_effect=get_json),
        _get_thread_metadata=metadata,
        _nudge_thread_from_payload=lambda value: value,
    )
    kwargs = dict(
        access_token=helper._state_secret(),
        user_id="owner",
        binding=["owner", "gmail", "account", "generation"],
        require_current=AsyncMock(),
    )
    first = await scan_followup_page(helper, cursor=None, **kwargs)
    assert first["coverage"]["complete"] is False and first["coverage"]["failed_threads"] == 1
    for cursor, binding in [
        (first["next_cursor"] + "x", kwargs["binding"]),
        (first["next_cursor"], ["another-owner"]),
        (first["next_cursor"], ["owner", "gmail", "reconnected", "generation"]),
    ]:
        with pytest.raises(GmailApiError):
            await scan_followup_page(helper, cursor=cursor, **{**kwargs, "binding": binding})
    final = await scan_followup_page(helper, cursor=first["next_cursor"], **kwargs)
    assert final["coverage"]["complete"] is True and final["coverage"]["scanned_threads"] == 1
    assert (
        len([call for call in helper._http_get_json.call_args_list if call.args[0] == THREADS_URL])
        == 2
    )


@pytest.mark.asyncio
async def test_followup_scan_rechecks_owner_before_releasing_provider_results():
    from hushh_mcp.services.gmail_followup_scan import scan_followup_page

    helper = SimpleNamespace(
        _state_secret=lambda: "fixture",
        _http_get_json=AsyncMock(side_effect=[{"emailAddress": "owner@example.com"}, {}]),
        _get_thread_metadata=AsyncMock(),
        _nudge_thread_from_payload=lambda value: value,
    )
    require_current = AsyncMock(side_effect=[None, PermissionError("Owner changed")])
    with pytest.raises(PermissionError):
        await scan_followup_page(
            helper,
            access_token=helper._state_secret(),
            user_id="owner",
            binding=["owner"],
            cursor=None,
            require_current=require_current,
        )


@pytest.mark.asyncio
async def test_followup_scan_keeps_long_continuations_bounded_and_refuses_unknown_account():
    from hushh_mcp.services.gmail_followup_scan import THREADS_URL, scan_followup_page
    from hushh_mcp.services.gmail_nudges import NudgeThread

    async def get_json(url, *, token, params=None):
        if url != THREADS_URL:
            return {"emailAddress": "owner@example.com"}
        page = int((params or {}).get("pageToken", "0").split("-")[0])
        return {
            "threads": [{"id": str(page)}],
            **({"nextPageToken": f"{page + 1}-" + "x" * 2048} if page < 149 else {}),
        }

    helper = SimpleNamespace(
        _state_secret=lambda: "fixture-only",
        _http_get_json=AsyncMock(side_effect=get_json),
        _get_thread_metadata=AsyncMock(return_value=NudgeThread(thread_id="thread", messages=())),
        _nudge_thread_from_payload=lambda value: value,
    )
    cursor = None
    for _ in range(150):
        result = await scan_followup_page(
            helper,
            access_token=helper._state_secret(),
            user_id="owner",
            binding=["owner", "generation"],
            cursor=cursor,
            require_current=AsyncMock(),
        )
        cursor = result["next_cursor"]
        assert cursor is None or len(cursor) <= 8100
    assert result["coverage"]["scanned_threads"] == 150 and result["coverage"]["complete"]
    helper._http_get_json = AsyncMock(return_value={})
    with pytest.raises(GmailApiError, match="account could not be verified"):
        await scan_followup_page(
            helper,
            access_token=helper._state_secret(),
            user_id="owner",
            binding=["owner"],
            cursor=None,
            require_current=AsyncMock(),
        )


@pytest.mark.asyncio
async def test_followup_scan_refuses_token_resolved_during_account_or_grant_change(monkeypatch):
    service = GmailReceiptsService()
    monkeypatch.setattr(
        service,
        "read_grant_binding",
        AsyncMock(
            side_effect=[
                ("owner", "account", "generation-one", "xmin"),
                ("owner", "account", "generation-two", "xmin"),
            ]
        ),
    )
    monkeypatch.setattr(service, "get_read_access_token", AsyncMock(return_value="fixture-only"))
    provider = AsyncMock()
    monkeypatch.setattr(service, "_http_get_json", provider)
    with pytest.raises(GmailApiError, match="access changed"):
        await service.list_nudges(user_id="owner", scan_all=True)
    provider.assert_not_called()
