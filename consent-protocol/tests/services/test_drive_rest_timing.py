"""Provider call timings expose only bounded operational labels."""

# ruff: noqa: S106 -- synthetic tokens and addresses are redaction markers.

import logging
import re
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import google_drive_rest_transport as rest
from hushh_mcp.services.google_drive_adapter import (
    CONTENT_LIMIT,
    LIVE_POLICY_HASH,
    DriveReadError,
    GoogleDriveAdapter,
)
from hushh_mcp.services.google_drive_permission_adapter import (
    DrivePermissionError,
    GoogleDrivePermissionAdapter,
)


@pytest.mark.asyncio
async def test_drive_list_timing_excludes_query_and_provider_details(caplog):
    caplog.set_level(logging.INFO, logger="hushh_mcp.services.google_drive_adapter")
    adapter = GoogleDriveAdapter()
    adapter._get_private = AsyncMock(return_value=b"{}")

    await adapter._get(
        "/files",
        access_token="secret-token",
        params={"q": "private search words"},
        limit=CONTENT_LIMIT,
    )

    assert "drive_rest.timing operation=list outcome=ok duration_ms=" in caplog.text
    assert "private search words" not in caplog.text
    assert "secret-token" not in caplog.text


@pytest.mark.asyncio
async def test_single_file_read_reports_channel_and_stage_times_without_rows(caplog, monkeypatch):
    caplog.set_level(logging.INFO, logger="hushh_mcp.services.google_drive_rest_transport")
    monkeypatch.setattr(rest, "connector_feature_enabled", lambda *_: True)
    granted = {
        "status": "connected",
        "validation_state": "verified",
        "verified_policy_hash": LIVE_POLICY_HASH,
        "connection_generation": 3,
    }
    drive = rest.GoogleDriveRestTransport(
        oauth=SimpleNamespace(
            current_credential=AsyncMock(return_value=(granted, {"accessToken": "secret-token"})),
            lifecycle=SimpleNamespace(read=AsyncMock(return_value=granted)),
        ),
        adapter=SimpleNamespace(
            get_file_facts=AsyncMock(return_value={"id": "private-file-id", "title": "Private"})
        ),
    )

    await drive.read_tool(
        user_id="private-owner",
        tool_name="get_file_metadata",
        arguments={"fileId": "private-file-id"},
    )

    assert re.search(
        r"drive_rest\.call channel=google_drive_rest_v3 profile=live tool=get_file_metadata "
        r"rows=-1 more=-1 credential_ms=\d+\.\d\d provider_ms=\d+\.\d\d recheck_ms=\d+\.\d\d "
        r"total_ms=\d+\.\d\d",
        caplog.text,
    )
    for private in ("private-file-id", "private-owner", "secret-token", "Private"):
        assert private not in caplog.text


@pytest.mark.asyncio
async def test_drive_file_failure_timing_excludes_file_id(caplog):
    caplog.set_level(logging.INFO, logger="hushh_mcp.services.google_drive_adapter")
    adapter = GoogleDriveAdapter()
    adapter._get_private = AsyncMock(side_effect=DriveReadError("provider_unavailable"))

    with pytest.raises(DriveReadError, match="provider_unavailable"):
        await adapter._get(
            "/files/private-file-id",
            access_token="secret-token",
            params={},
            limit=CONTENT_LIMIT,
        )

    assert (
        "drive_rest.timing operation=metadata outcome=provider_unavailable duration_ms="
        in caplog.text
    )
    assert "private-file-id" not in caplog.text
    assert "secret-token" not in caplog.text


@pytest.mark.asyncio
async def test_permission_create_timing_excludes_recipient_and_file(caplog):
    caplog.set_level(logging.INFO, logger="hushh_mcp.services.google_drive_permission_adapter")
    adapter = GoogleDrivePermissionAdapter()
    adapter._exchange_private = AsyncMock(return_value={"id": "private-permission-id"})

    await adapter._exchange(
        "create",
        file_id="private-file-id",
        access_token="secret-token",
        require_current=AsyncMock(),
        email="private@example.invalid",
    )

    assert "drive_permission_rest.timing operation=create outcome=ok duration_ms=" in caplog.text
    for private in (
        "private-permission-id",
        "private-file-id",
        "secret-token",
        "private@example.invalid",
    ):
        assert private not in caplog.text


@pytest.mark.asyncio
async def test_permission_failure_timing_uses_only_safe_code(caplog):
    caplog.set_level(logging.INFO, logger="hushh_mcp.services.google_drive_permission_adapter")
    adapter = GoogleDrivePermissionAdapter()
    adapter._exchange_private = AsyncMock(
        side_effect=DrivePermissionError("permission_outcome_unknown")
    )

    with pytest.raises(DrivePermissionError, match="permission_outcome_unknown"):
        await adapter._exchange(
            "create",
            file_id="private-file-id",
            access_token="secret-token",
            require_current=AsyncMock(),
            email="private@example.invalid",
        )

    assert (
        "drive_permission_rest.timing operation=create outcome=permission.outcome.unknown duration_ms="
        in caplog.text
    )
    assert "private-file-id" not in caplog.text
    assert "private@example.invalid" not in caplog.text


@pytest.mark.feature_drive_packets
@pytest.mark.trace_loop
async def test_financial_candidate_metadata_uses_the_real_fenced_group_transport(monkeypatch):
    from hushh_mcp.services.drive_financial_packet_tagging import CandidateReads
    from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
    from tests.services.test_google_drive_rest_transport import FILE_ID, transport

    adapter = SimpleNamespace(
        get_file_facts=AsyncMock(return_value={"version": "1", "trashed": False})
    )
    drive = transport(adapter=adapter, monkeypatch=monkeypatch)
    source = {"id": FILE_ID, "sourceVersion": "1"}
    job = {"user_id": "synthetic-owner", "connection_generation": 7, "items": [{"source": source}]}
    reads = CandidateReads(SimpleNamespace(current=AsyncMock(), transport=drive), job)
    await reads.verify_source(source)
    drive._oauth.current_credential.assert_awaited_once_with(
        user_id="synthetic-owner", required_profile="live"
    )
    adapter.get_file_facts.assert_awaited_once()
    adapter.get_file_facts.reset_mock()
    reads.job = {**job, "connection_generation": 6}
    with pytest.raises(DriveOAuthError, match="connection_changed"):
        await reads.verify_source(source)
    adapter.get_file_facts.assert_not_awaited()


@pytest.mark.feature_drive_packets
@pytest.mark.trace_loop
@pytest.mark.parametrize("failure", ["missing_operation", "unknown_oauth_code"])
async def test_financial_tagger_settles_real_transport_oauth_failures_without_private_logs(
    monkeypatch, caplog, failure
):
    from datetime import UTC, datetime

    from hushh_mcp.services import drive_financial_packet_tag_store as tags
    from hushh_mcp.services import drive_financial_packet_tagging as tagging
    from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
    from tests.services.test_google_drive_rest_transport import FILE_ID, transport

    monkeypatch.setenv("DRIVE_PERIOD_PACKETS_ENABLED", "true")
    caplog.set_level(logging.INFO, logger="financial_packet_tagging")
    adapter = SimpleNamespace(get_file_facts=AsyncMock())
    drive = transport(adapter=adapter, monkeypatch=monkeypatch)
    if failure == "missing_operation":
        # Negative control: reproduce the production omission on the real operation table.
        monkeypatch.delitem(rest._GROUP_INDEX_OPERATIONS, "get_file_metadata")
    else:
        drive._oauth.current_credential.side_effect = DriveOAuthError(
            "synthetic-private-provider-message"
        )
    source = {
        "id": FILE_ID,
        "sourceVersion": "1",
        "mimeType": "text/plain",
        "name": "Synthetic private title",
    }
    job = {
        "user_id": "synthetic-owner",
        "connection_generation": 7,
        "items": [{"source": source}],
        "packet_id": "11111111-1111-4111-8111-111111111111",
        "tagging_next_at": datetime.now(UTC),
    }
    commit = AsyncMock(return_value="queued")
    monkeypatch.setattr(tags, "claim", AsyncMock(return_value=job))
    monkeypatch.setattr(tags, "cached", AsyncMock(return_value={}))
    monkeypatch.setattr(tags, "require_current", AsyncMock())
    monkeypatch.setattr(tags, "commit", commit)
    monkeypatch.setattr(tagging, "admit_hub_content", AsyncMock())
    worker = tagging.FinancialPacketTagger(
        store=object(), transport=drive, embedder=SimpleNamespace(embed=AsyncMock())
    )
    assert await worker.run_one() == "deferred"
    commit.assert_awaited_once_with(worker.store, job, error=True)
    adapter.get_file_facts.assert_not_awaited()
    if failure == "missing_operation":
        drive._oauth.current_credential.assert_not_awaited()
    worker.embedder.embed.assert_not_awaited()
    code = "connector_unavailable" if failure == "missing_operation" else "oauth_unavailable"
    assert f"period_packet.tagging outcome=deferred code={code}" in caplog.text
    for private in (
        FILE_ID,
        source["name"],
        job["user_id"],
        job["packet_id"],
        "synthetic-private-provider-message",
        "synthetic-live-grant",
    ):
        assert private not in caplog.text
