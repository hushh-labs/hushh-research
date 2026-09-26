"""Provider call timings expose only bounded operational labels."""

# ruff: noqa: S106 -- synthetic tokens and addresses are redaction markers.

import logging
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.google_drive_adapter import (
    CONTENT_LIMIT,
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
        "drive_permission_rest.timing operation=create outcome=permission_outcome_unknown duration_ms="
        in caplog.text
    )
    assert "private-file-id" not in caplog.text
    assert "private@example.invalid" not in caplog.text
