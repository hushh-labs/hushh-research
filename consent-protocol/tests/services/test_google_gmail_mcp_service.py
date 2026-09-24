from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import google_gmail_mcp_service as gmail
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.gmail_receipts_service import GmailApiError


@pytest.mark.asyncio
async def test_reviewed_draft_uses_compose_grant_and_projects_only_id(monkeypatch):
    connections = SimpleNamespace(
        get_compose_access_token=AsyncMock(return_value="synthetic-compose-token")
    )
    listing = AsyncMock(
        return_value=[
            {
                "name": "create_draft",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "to": {"type": "array", "items": {"type": "string"}},
                        "cc": {"type": "array", "items": {"type": "string"}},
                        "bcc": {"type": "array", "items": {"type": "string"}},
                        "subject": {"type": "string"},
                        "body": {"type": "string"},
                    },
                    "additionalProperties": False,
                },
            }
        ]
    )
    calling = AsyncMock(
        return_value=ExternalMcpToolResult(
            False,
            {"id": "draft-1", "plaintextBody": "private body", "toRecipients": ["private"]},
            False,
        )
    )
    monkeypatch.setattr(gmail, "list_tools", listing)
    monkeypatch.setattr(gmail, "call_tool", calling)
    service = gmail.GoogleGmailMcpService(connections=connections)
    result = await service.create_reviewed_draft(
        user_id="owner-a",
        draft_payload={"to": "recipient@example.com", "subject": "Hello", "body": "Reviewed body"},
    )
    assert result == {"status": "saved", "draft_id": "draft-1"}
    calling.assert_awaited_once()
    assert calling.await_args.args[0] == "create_draft"
    assert calling.await_args.kwargs["headers"] == {
        "Authorization": "Bearer synthetic-compose-token"
    }
    assert calling.await_args.args[1]["to"] == ["recipient@example.com"]
    with pytest.raises(GmailApiError):
        connections.get_compose_access_token.side_effect = GmailApiError(
            "Permission required", status_code=409
        )
        await service.create_reviewed_draft(
            user_id="owner-b",
            draft_payload={"to": "recipient@example.com", "body": "No access"},
        )
    assert calling.await_count == 1


@pytest.mark.asyncio
async def test_exact_catalog_rejects_writes_invalid_arguments_and_other_owner(monkeypatch):
    async def token(*, user_id):
        if user_id != "owner-a":
            raise GmailApiError("Connect Gmail", status_code=403)
        return "synthetic-token"

    connections = SimpleNamespace(get_read_access_token=AsyncMock(side_effect=token))
    listing = AsyncMock(
        return_value=[
            {"name": "create_draft", "inputSchema": {"type": "object"}},
            {
                "name": "get_thread",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "threadId": {"type": "string"},
                        "messageFormat": {
                            "type": "string",
                            "enum": ["FULL_CONTENT", "MINIMAL", "METADATA_ONLY"],
                            "default": "FULL_CONTENT",
                        },
                    },
                    "required": ["threadId"],
                    "additionalProperties": False,
                },
            },
        ]
    )
    calling = AsyncMock(
        return_value=ExternalMcpToolResult(
            False,
            {
                "id": "thread-1",
                "messages": [
                    {
                        "id": "message-1",
                        "sender": "sender@example.test",
                        "toRecipients": ["owner@example.test"],
                        "ccRecipients": [],
                        "date": "2026-09-24",
                        "labelIds": ["INBOX"],
                        "subject": "Review",
                        "snippet": "PRIVATE SNIPPET",
                        "plaintextBody": "PRIVATE BODY",
                        "htmlBody": "<p>PRIVATE BODY</p>",
                        "attachments": [{"filename": "PRIVATE FILE"}],
                    }
                ],
            },
            False,
        )
    )
    monkeypatch.setattr(gmail, "list_tools", listing)
    monkeypatch.setattr(gmail, "call_tool", calling)
    service = gmail.GoogleGmailMcpService(connections=connections)
    discovered = await service.discover_read_tools(user_id="owner-a")
    assert [tool["name"] for tool in discovered] == ["get_thread"]
    assert discovered[0]["inputSchema"]["properties"]["messageFormat"]["enum"] == ["METADATA_ONLY"]
    assert "default" not in discovered[0]["inputSchema"]["properties"]["messageFormat"]
    assert "messageFormat" in discovered[0]["inputSchema"]["required"]
    for owner, tool, args in [
        ("owner-a", "create_draft", {}),
        ("owner-a", "get_thread", {}),
        ("owner-b", "get_thread", {"threadId": "synthetic"}),
        ("owner-a", "get_thread", {"threadId": "x" * 5000}),
        ("owner-a", "get_thread", {"threadId": "synthetic", "messageFormat": "FULL_CONTENT"}),
        ("owner-a", "get_thread", {"threadId": "synthetic", "messageFormat": "MINIMAL"}),
        ("owner-a", "get_thread", {"threadId": "synthetic", "messageFormat": None}),
    ]:
        with pytest.raises(GmailApiError):
            await service.read_tool(user_id=owner, tool_name=tool, arguments=args)
    calling.assert_not_awaited()
    result = await service.read_tool(
        user_id="owner-a", tool_name="get_thread", arguments={"threadId": "synthetic"}
    )
    assert result.payload == {
        "thread": {
            "id": "thread-1",
            "messages": [
                {
                    "id": "message-1",
                    "sender": "sender@example.test",
                    "toRecipients": ["owner@example.test"],
                    "ccRecipients": [],
                    "date": "2026-09-24",
                    "labelIds": ["INBOX"],
                }
            ],
        },
        "metadata_only": True,
    }
    assert "PRIVATE" not in str(result.payload)
    calling.assert_awaited_once_with(
        "get_thread",
        {"threadId": "synthetic", "messageFormat": "METADATA_ONLY"},
        endpoint=gmail.GOOGLE_GMAIL_MCP_ENDPOINT,
        headers={"Authorization": "Bearer synthetic-token"},
    )
    listing.assert_awaited_once()


@pytest.mark.asyncio
async def test_drafts_are_not_discoverable_or_callable(monkeypatch):
    connections = SimpleNamespace(get_read_access_token=AsyncMock(return_value="synthetic-token"))
    listing = AsyncMock(
        return_value=[
            {"name": "list_drafts", "inputSchema": {"type": "object"}},
            {"name": "list_labels", "inputSchema": {"type": "object"}},
        ]
    )
    calling = AsyncMock()
    monkeypatch.setattr(gmail, "list_tools", listing)
    monkeypatch.setattr(gmail, "call_tool", calling)
    service = gmail.GoogleGmailMcpService(connections=connections)
    assert [item["name"] for item in await service.discover_read_tools(user_id="owner-a")] == [
        "list_labels"
    ]
    with pytest.raises(GmailApiError):
        await service.read_tool(user_id="owner-a", tool_name="list_drafts", arguments={})
    calling.assert_not_awaited()


@pytest.mark.asyncio
async def test_unknown_gmail_result_shape_fails_closed(monkeypatch):
    connections = SimpleNamespace(get_read_access_token=AsyncMock(return_value="synthetic-token"))
    monkeypatch.setattr(
        gmail,
        "list_tools",
        AsyncMock(
            return_value=[
                {
                    "name": "get_thread",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "threadId": {"type": "string"},
                            "messageFormat": {"type": "string"},
                        },
                        "required": ["threadId"],
                    },
                }
            ]
        ),
    )
    monkeypatch.setattr(
        gmail,
        "call_tool",
        AsyncMock(return_value=ExternalMcpToolResult(False, {"body": "PRIVATE"}, False)),
    )
    with pytest.raises(GmailApiError) as error:
        await gmail.GoogleGmailMcpService(connections=connections).read_tool(
            user_id="owner-a", tool_name="get_thread", arguments={"threadId": "synthetic"}
        )
    assert error.value.status_code == 502


def test_search_and_label_projection_never_return_provider_body_fields():
    threads, truncated = gmail._metadata_result(
        "search_threads",
        {
            "threads": [
                {
                    "id": "thread-1",
                    "messages": [
                        {
                            "id": "message-1",
                            "sender": "sender@example.test",
                            "date": "2026-09-24",
                            "labelIds": ["INBOX"],
                            "subject": "PRIVATE SUBJECT",
                            "snippet": "PRIVATE SNIPPET",
                            "plaintextBody": "PRIVATE BODY",
                        }
                    ],
                }
            ],
            "nextPageToken": "PRIVATE CURSOR",
        },
    )
    assert threads == {
        "threads": [
            {
                "id": "thread-1",
                "messages": [
                    {
                        "id": "message-1",
                        "sender": "sender@example.test",
                        "date": "2026-09-24",
                        "labelIds": ["INBOX"],
                    }
                ],
            }
        ],
        "metadata_only": True,
    }
    assert truncated is True
    labels, _ = gmail._metadata_result(
        "list_labels", {"labels": [{"id": "label-1", "name": "Work", "messages": "PRIVATE"}]}
    )
    assert labels == {
        "labels": [{"id": "label-1", "name": "Work"}],
        "metadata_only": True,
    }
    assert "PRIVATE" not in str((threads, labels))


@pytest.mark.asyncio
async def test_search_forces_metadata_view_and_rejects_broader_view(monkeypatch):
    connections = SimpleNamespace(get_read_access_token=AsyncMock(return_value="synthetic-token"))
    listing = AsyncMock(
        return_value=[
            {
                "name": "search_threads",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "view": {
                            "type": "string",
                            "enum": ["THREAD_VIEW_MINIMAL", "THREAD_VIEW_METADATA_ONLY"],
                        },
                    },
                    "additionalProperties": False,
                },
            }
        ]
    )
    calling = AsyncMock(
        return_value=ExternalMcpToolResult(
            False,
            {
                "threads": [
                    {
                        "id": "thread-1",
                        "messages": [{"id": "message-1", "sender": "sender@example.test"}],
                    }
                ],
            },
            False,
        )
    )
    monkeypatch.setattr(gmail, "list_tools", listing)
    monkeypatch.setattr(gmail, "call_tool", calling)
    service = gmail.GoogleGmailMcpService(connections=connections)
    discovered = await service.discover_read_tools(user_id="owner-a")
    assert discovered[0]["inputSchema"]["properties"]["view"]["enum"] == [
        "THREAD_VIEW_METADATA_ONLY"
    ]
    with pytest.raises(GmailApiError):
        await service.read_tool(
            user_id="owner-a",
            tool_name="search_threads",
            arguments={
                "query": "from:sender@example.test",
                "view": "THREAD_VIEW_MINIMAL",
            },
        )
    calling.assert_not_awaited()
    result = await service.read_tool(
        user_id="owner-a",
        tool_name="search_threads",
        arguments={
            "query": "from:sender@example.test",
        },
    )
    assert result.payload["threads"][0]["messages"][0]["sender"] == "sender@example.test"
    calling.assert_awaited_once_with(
        "search_threads",
        {"query": "from:sender@example.test", "view": "THREAD_VIEW_METADATA_ONLY"},
        endpoint=gmail.GOOGLE_GMAIL_MCP_ENDPOINT,
        headers={"Authorization": "Bearer synthetic-token"},
    )


@pytest.mark.asyncio
async def test_missing_metadata_mode_in_provider_schema_blocks_call(monkeypatch):
    connections = SimpleNamespace(get_read_access_token=AsyncMock(return_value="synthetic-token"))
    monkeypatch.setattr(
        gmail,
        "list_tools",
        AsyncMock(
            return_value=[
                {
                    "name": "get_thread",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"threadId": {"type": "string"}},
                    },
                }
            ]
        ),
    )
    calling = AsyncMock()
    monkeypatch.setattr(gmail, "call_tool", calling)
    service = gmail.GoogleGmailMcpService(connections=connections)
    assert await service.discover_read_tools(user_id="owner-a") == []
    with pytest.raises(GmailApiError):
        await service.read_tool(
            user_id="owner-a", tool_name="get_thread", arguments={"threadId": "synthetic"}
        )
    calling.assert_not_awaited()
