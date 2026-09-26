"""Safe timing telemetry for owner-initiated Drive sharing."""

import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.drive_live_query_service import DriveLiveQueryService


@pytest.fixture
def service(monkeypatch):
    monkeypatch.setattr(
        "hushh_mcp.services.drive_live_query_service.connector_feature_enabled",
        lambda *_args: True,
    )
    owner_shares = SimpleNamespace(
        trusted_recipients=AsyncMock(
            return_value={
                "eligible": [{"userId": "private-user-id", "name": "Private Person"}],
                "excluded": [],
            }
        ),
        existing_group=AsyncMock(return_value=[]),
        create=AsyncMock(
            return_value={
                "requestId": "private-request-id",
                "recipientName": "Private Person",
                "status": "ready",
                "shareRequestId": None,
                "files": [{"ref": "f1", "name": "Private Filename"}],
            }
        ),
    )
    chat = SimpleNamespace(
        run_live_query=AsyncMock(
            return_value={
                "status": "ok",
                "share_files": [{"file_id": "private-file-id", "name": "Private Filename"}],
            }
        )
    )
    return DriveLiveQueryService(
        store=SimpleNamespace(),
        owner_shares=owner_shares,
        chat=chat,
        require_owner=AsyncMock(),
        recipient_identity=AsyncMock(return_value=SimpleNamespace()),
    )


@pytest.mark.asyncio
async def test_trusted_prepare_logs_stage_durations_without_private_values(service, caplog):
    caplog.set_level(logging.INFO, logger="hushh_mcp.services.drive_live_query_service")

    result = await service.prepare_trusted_share(
        user_id="private-owner-id",
        client_request_id="private-client-id",
        query="Private query text",
        consent_token="private-token",  # noqa: S106 - synthetic redaction marker
    )

    assert result["status"] == "ready"
    for stage in (
        "trusted_members",
        "recipient_identity",
        "existing_group",
        "live_drive_query",
        "persist_group",
        "trusted_prepare_total",
    ):
        assert f"stage={stage} outcome=" in caplog.text
    assert "duration_ms=" in caplog.text
    for private in (
        "private-owner-id",
        "private-client-id",
        "Private query text",
        "private-token",
        "private-user-id",
        "private-request-id",
        "private-file-id",
        "Private Filename",
        "Private Person",
    ):
        assert private not in caplog.text


@pytest.mark.asyncio
async def test_trusted_prepare_without_recipients_skips_drive_and_logs_outcome(service, caplog):
    caplog.set_level(logging.INFO, logger="hushh_mcp.services.drive_live_query_service")
    service.owner_shares.trusted_recipients.return_value = {"eligible": [], "excluded": []}

    result = await service.prepare_trusted_share(
        user_id="private-owner-id",
        client_request_id="private-client-id",
        query="Private query text",
        consent_token="private-token",  # noqa: S106 - synthetic redaction marker
    )

    assert result["status"] == "no_recipients"
    service.chat.run_live_query.assert_not_awaited()
    assert "stage=trusted_prepare_total outcome=no_recipients duration_ms=" in caplog.text
    assert "stage=live_drive_query" not in caplog.text


@pytest.mark.asyncio
async def test_failed_live_query_logs_no_provider_detail(service, caplog):
    caplog.set_level(logging.INFO, logger="hushh_mcp.services.drive_live_query_service")
    service.chat.run_live_query.side_effect = RuntimeError("Private provider URL and file ID")

    with pytest.raises(RuntimeError, match="Private provider URL"):
        await service.prepare_trusted_share(
            user_id="private-owner-id",
            client_request_id="private-client-id",
            query="Private query text",
            consent_token="private-token",  # noqa: S106 - synthetic redaction marker
        )

    assert "stage=live_drive_query outcome=error duration_ms=" in caplog.text
    assert "stage=trusted_prepare_total outcome=error duration_ms=" in caplog.text
    assert "Private provider URL" not in caplog.text
    assert "Private query text" not in caplog.text
