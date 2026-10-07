"""Instagram action authority and ownership boundaries without provider traffic."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from hushh_mcp.services import external_connector_instagram_capabilities as actions
from hushh_mcp.services.external_connector_instagram_oauth import (
    POLICY_HASH,
    InstagramConnectorError,
)

OWNER = "owner-a"
ACCOUNT = "456"


@pytest.fixture
def service():
    row = {
        "status": "connected",
        "validation_state": "verified",
        "verified_policy_hash": POLICY_HASH,
        "connection_generation": 5,
        "credential_version": 2,
    }
    credential = {
        "instagramUserId": ACCOUNT,
        "accessToken": "synthetic-owner-grant",
        "grantedScopes": [
            "instagram_business_content_publish",
            "instagram_business_manage_comments",
            "instagram_business_manage_messages",
        ],
    }
    oauth = SimpleNamespace(
        current_credential=AsyncMock(return_value=(row, credential)),
        lifecycle=SimpleNamespace(read=AsyncMock(return_value=row)),
    )
    return actions.ExternalConnectorInstagramCapabilities(oauth)


def test_signed_container_is_bound_to_owner_account_and_connection_generation():
    original = actions._Binding(OWNER, ACCOUNT, 5, 2, "synthetic-grant")
    handle = actions.ExternalConnectorInstagramCapabilities._sign_container(
        original, "123", "photo"
    )
    open_handle = actions.ExternalConnectorInstagramCapabilities._open_container
    assert open_handle(original, handle) == ("123", "photo")
    for changed in (
        actions._Binding("other-owner", ACCOUNT, 5, 2, "synthetic-grant"),
        actions._Binding(OWNER, "999", 5, 2, "synthetic-grant"),
        actions._Binding(OWNER, ACCOUNT, 6, 2, "synthetic-grant"),
    ):
        with pytest.raises(InstagramConnectorError, match="invalid_container"):
            open_handle(changed, handle)
    with pytest.raises(InstagramConnectorError, match="invalid_container"):
        open_handle(original, handle + "tampered")


@pytest.mark.asyncio
async def test_publish_requires_owner_confirmation_and_current_generation(service):
    service.oauth._graph_get = AsyncMock(return_value={"id": "123", "status_code": "FINISHED"})
    service._change = AsyncMock(return_value={"id": "789"})
    handle = service._sign_container(
        actions._Binding(OWNER, ACCOUNT, 5, 2, "synthetic-grant"), "123", "photo"
    )
    with pytest.raises(InstagramConnectorError, match="owner_confirmation_required"):
        await service.publish_container(user_id=OWNER, handle=handle, confirmed=False)
    service._change.assert_not_awaited()

    service.oauth.lifecycle.read.return_value = {
        "status": "connected",
        "validation_state": "verified",
        "verified_policy_hash": POLICY_HASH,
        "connection_generation": 6,
        "credential_version": 2,
    }
    # A stale grant must be fenced even when the caller retained a valid
    # signed handle from the earlier generation.
    with pytest.raises(InstagramConnectorError, match="connection_changed"):
        await service.publish_container(user_id=OWNER, handle=handle, confirmed=True)
    service._change.assert_not_awaited()
    service.oauth._graph_get.assert_not_awaited()


@pytest.mark.asyncio
async def test_carousel_rejects_duplicate_children_before_provider_write(service):
    service._change = AsyncMock()
    binding = actions._Binding(OWNER, ACCOUNT, 5, 2, "synthetic-grant")
    child = service._sign_container(binding, "123", "photo_child")
    with pytest.raises(InstagramConnectorError, match="invalid_carousel"):
        await service.create_carousel_container(
            user_id=OWNER, children=[child, child], confirmed=True
        )
    service._change.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "url_field"),
    [
        ("create_story_image_container", "image_url"),
        ("create_story_video_container", "video_url"),
    ],
)
async def test_story_container_uses_documented_media_type_and_owner_confirmation(
    service, method, url_field
):
    service._change = AsyncMock(return_value={"id": "123"})
    create = getattr(service, method)
    url = "https://media.example.test/story-file"
    with pytest.raises(InstagramConnectorError, match="owner_confirmation_required"):
        await create(user_id=OWNER, **{url_field: url}, confirmed=False)
    service._change.assert_not_awaited()

    result = await create(user_id=OWNER, **{url_field: url}, confirmed=True)
    assert result["kind"] == "story"
    assert service._open_container(
        actions._Binding(OWNER, ACCOUNT, 5, 2, "synthetic-grant"),
        result["containerHandle"],
    ) == ("123", "story")
    assert service._change.await_args.args[1:] == (
        "POST",
        f"{ACCOUNT}/media",
        {"media_type": "STORIES", url_field: url},
    )


@pytest.mark.asyncio
async def test_ready_story_can_publish_once_after_durable_claim(service):
    binding = actions._Binding(OWNER, ACCOUNT, 5, 2, "synthetic-grant")
    handle = service._sign_container(binding, "123", "story")
    service._get = AsyncMock(return_value={"id": "123", "status_code": "FINISHED"})
    service._change = AsyncMock(return_value={"id": "789"})
    service.claim_publish = AsyncMock(return_value=True)

    assert await service.publish_container(user_id=OWNER, handle=handle, confirmed=True) == {
        "mediaId": "789"
    }
    service.claim_publish.assert_awaited_once_with(OWNER, ACCOUNT, 5, "123")
    assert service._change.await_args.args[1:] == (
        "POST",
        f"{ACCOUNT}/media_publish",
        {"creation_id": "123"},
    )


@pytest.mark.asyncio
async def test_publish_claim_prevents_duplicate_provider_submission(service):
    binding = actions._Binding(OWNER, ACCOUNT, 5, 2, "synthetic-grant")
    handle = service._sign_container(binding, "123", "photo")
    service._get = AsyncMock(return_value={"id": "123", "status_code": "FINISHED"})
    service._change = AsyncMock(return_value={"id": "789"})

    # A missing durable claim must fail closed even if the media is ready.
    with pytest.raises(InstagramConnectorError, match="publication_claim_unavailable"):
        await service.publish_container(user_id=OWNER, handle=handle, confirmed=True)
    service._change.assert_not_awaited()

    service.claim_publish = AsyncMock(side_effect=[True, False])
    assert await service.publish_container(user_id=OWNER, handle=handle, confirmed=True) == {
        "mediaId": "789"
    }
    with pytest.raises(InstagramConnectorError, match="publication_already_claimed"):
        await service.publish_container(user_id=OWNER, handle=handle, confirmed=True)
    assert service.claim_publish.await_args_list[0].args == (OWNER, ACCOUNT, 5, "123")
    service._change.assert_awaited_once()


@pytest.mark.asyncio
async def test_write_transport_bounds_response_and_reports_unknown_outcome(service, monkeypatch):
    binding = actions._Binding(OWNER, ACCOUNT, 5, 2, "synthetic-grant")
    private_detail = "PRIVATE_GRAPH_PROVIDER_SENTINEL"
    real_client = httpx.AsyncClient
    for response in (
        httpx.Response(500, json={"error": private_detail}),
        httpx.Response(200, stream=httpx.ByteStream(b"x" * (actions._MAX_RESPONSE_BYTES + 1))),
    ):
        requests = []

        def handler(request, result=response, seen=requests):
            seen.append(request)
            return result

        client = real_client(transport=httpx.MockTransport(handler))
        monkeypatch.setattr(actions.httpx, "AsyncClient", lambda client=client, **_: client)
        with pytest.raises(InstagramConnectorError, match="provider_outcome_unknown") as caught:
            await service._change(
                binding, "POST", f"{ACCOUNT}/media_publish", {"creation_id": "123"}
            )
        assert private_detail not in str(caught.value)
        assert len(requests) == 1


@pytest.mark.asyncio
async def test_comment_mutation_rejects_comment_on_another_accounts_media(service):
    async def graph_read(_binding, path, _params):
        if path == "123":
            return {"id": "123", "media": {"id": "789"}}
        if path == "789":
            return {"id": "789", "owner": {"id": "other-account"}}
        raise AssertionError(f"unexpected path: {path}")

    service._get = AsyncMock(side_effect=graph_read)
    service._change = AsyncMock()
    with pytest.raises(InstagramConnectorError, match="media_not_owned"):
        await service.reply_to_comment(
            user_id=OWNER, comment_id="123", message="Thanks!", confirmed=True
        )
    service._change.assert_not_awaited()


@pytest.mark.asyncio
async def test_comment_hide_uses_graph_query_parameter_after_ownership_check(service):
    service._owned_comment = AsyncMock(return_value="123")
    service._change = AsyncMock(return_value={"success": True})
    assert await service.set_comment_hidden(
        user_id=OWNER, comment_id="123", hidden=True, confirmed=True
    ) == {"hidden": True}
    service._owned_comment.assert_awaited_once()
    assert service._change.await_args.args[1:] == ("POST", "123")
    assert service._change.await_args.kwargs == {"params": {"hide": "true"}}


@pytest.mark.asyncio
async def test_malformed_success_ids_leave_graph_write_outcome_unknown(service):
    service._owned_comment = AsyncMock(return_value="123")
    service._change = AsyncMock(return_value={})
    with pytest.raises(InstagramConnectorError, match="provider_outcome_unknown"):
        await service.reply_to_comment(
            user_id=OWNER, comment_id="123", message="Thanks!", confirmed=True
        )

    service._get = AsyncMock(return_value={"id": "456", "status_code": "FINISHED"})
    service.claim_publish = AsyncMock(return_value=True)
    handle = service._sign_container(
        actions._Binding(OWNER, ACCOUNT, 5, 2, "synthetic-grant"), "456", "photo"
    )
    service._change.return_value = {"id": "not-a-numeric-media-id"}
    with pytest.raises(InstagramConnectorError, match="provider_outcome_unknown"):
        await service.publish_container(user_id=OWNER, handle=handle, confirmed=True)


@pytest.mark.asyncio
async def test_message_send_requires_recent_inbound_message_from_recipient(service):
    service._change = AsyncMock(
        return_value={
            "recipient_id": "789",
            "message_id": "message_1",
        }
    )
    service.recent_messages = AsyncMock(
        return_value={
            "messages": [
                {
                    "senderId": ACCOUNT,
                    "createdTime": datetime.now(UTC).isoformat(),
                },
                {
                    "senderId": "789",
                    "createdTime": (datetime.now(UTC) - timedelta(hours=25)).isoformat(),
                },
            ]
        }
    )
    with pytest.raises(InstagramConnectorError, match="message_window_closed"):
        await service.send_text_message(
            user_id=OWNER, recipient_id="789", message="Hello", confirmed=True
        )
    service._change.assert_not_awaited()

    service.recent_messages.return_value = {
        "messages": [
            {
                "senderId": "789",
                "createdTime": datetime.now(UTC).isoformat(),
            }
        ]
    }
    assert await service.send_text_message(
        user_id=OWNER, recipient_id="789", message="Hello", confirmed=True
    ) == {"messageId": "message_1"}
    service._change.assert_awaited_once()
