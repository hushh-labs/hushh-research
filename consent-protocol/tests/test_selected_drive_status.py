"""Selected-file chat status is owner-bound, current and metadata-only."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.one_adk import selected_drive_status
from hushh_mcp.one_adk.external_read_boundary import STATE_EXECUTION_SURFACE


def context(*, user_id="owner", surface="typed_chat"):
    return SimpleNamespace(
        user_id=user_id,
        state={
            "hussh:user_id": "owner",
            "hussh:consent_token": "secret-ref",
            STATE_EXECUTION_SURFACE: surface,
        },
    )


def service(*, connection="connected", documents=(), after=None):
    row = {"status": connection, "connection_generation": 7} if connection else None
    rows = iter([row, row if after is None else after, row if after is None else after])
    lifecycle = SimpleNamespace(read=AsyncMock(side_effect=lambda **_kwargs: next(rows)))
    return SimpleNamespace(
        oauth=SimpleNamespace(lifecycle=lifecycle),
        documents=AsyncMock(return_value=list(documents)),
    )


@pytest.fixture(autouse=True)
def admitted(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("GOOGLE_DRIVE_CHAT_READS", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    monkeypatch.setattr(selected_drive_status, "resolve_request_secret", lambda _: "token")
    monkeypatch.setattr(
        selected_drive_status,
        "validate_first_party_owner_token",
        AsyncMock(return_value=SimpleNamespace()),
    )


async def test_connected_selected_processing_file_is_not_reported_missing(monkeypatch):
    selected = service(
        documents=[
            {"name": "aryanCV.pdf", "status": "parsing", "documentId": "private-id"},
            {"name": "private-other.pdf", "status": "ready"},
        ]
    )
    monkeypatch.setattr(selected_drive_status, "_service", lambda: selected)
    result = await selected_drive_status.inspect_selected_drive_files("aryan cv", context())
    assert result == {
        "source": selected_drive_status.PRIVATE_SOURCE,
        "status": "ok",
        "connection": "connected",
        "selectedCount": 2,
        "matchCount": 1,
        "matches": [{"name": "aryanCV.pdf", "status": "parsing"}],
        "matchesTruncated": False,
    }
    assert "private-id" not in str(result)
    assert "private-other" not in str(result)
    assert selected.documents.await_count == 2
    selected.documents.assert_awaited_with(user_id="owner")


async def test_connected_without_named_selection_does_not_claim_drive_file_absent(monkeypatch):
    monkeypatch.setattr(
        selected_drive_status,
        "_service",
        lambda: service(documents=[{"name": "other.pdf", "status": "ready"}]),
    )
    result = await selected_drive_status.inspect_selected_drive_files("aryan cv", context())
    assert result["connection"] == "connected"
    assert result["selectedCount"] == 1
    assert result["matches"] == []


def test_possessive_name_matches_compact_selected_filename():
    matches = selected_drive_status._matches(
        [{"name": "aryanCV.pdf", "status": "ready"}], "Aryan's CV"
    )
    assert [item["name"] for item in matches] == ["aryanCV.pdf"]


async def test_disconnected_drive_returns_no_private_catalog(monkeypatch):
    selected = service(connection=None)
    monkeypatch.setattr(selected_drive_status, "_service", lambda: selected)
    result = await selected_drive_status.inspect_selected_drive_files("aryan cv", context())
    assert result["connection"] == "disconnected"
    assert result["matches"] == []
    selected.documents.assert_not_awaited()


@pytest.mark.parametrize("user_id,surface", [("other", "typed_chat"), ("owner", "voice")])
async def test_wrong_owner_or_surface_cannot_read_status(monkeypatch, user_id, surface):
    monkeypatch.setattr(
        selected_drive_status, "_service", lambda: pytest.fail("metadata must not be read")
    )
    result = await selected_drive_status.inspect_selected_drive_files(
        "aryan cv", context(user_id=user_id, surface=surface)
    )
    assert result["status"] == "blocked"


async def test_connection_change_during_read_releases_no_names(monkeypatch):
    selected = service(
        documents=[{"name": "private.pdf", "status": "ready"}],
        after={"status": "revoked", "connection_generation": 8},
    )
    monkeypatch.setattr(selected_drive_status, "_service", lambda: selected)
    result = await selected_drive_status.inspect_selected_drive_files("private", context())
    assert result["status"] == "unavailable"
    assert "private.pdf" not in str(result)


async def test_selection_removed_during_read_releases_no_stale_name(monkeypatch):
    selected = service(documents=[{"name": "private.pdf", "status": "ready"}])
    selected.documents.side_effect = [
        [{"name": "private.pdf", "status": "ready"}],
        [],
    ]
    monkeypatch.setattr(selected_drive_status, "_service", lambda: selected)
    result = await selected_drive_status.inspect_selected_drive_files("private", context())
    assert result["status"] == "unavailable"
    assert "private.pdf" not in str(result)


async def test_revoked_owner_during_read_releases_no_names(monkeypatch):
    owner = AsyncMock(side_effect=[SimpleNamespace(), None])
    monkeypatch.setattr(selected_drive_status, "validate_first_party_owner_token", owner)
    monkeypatch.setattr(
        selected_drive_status,
        "_service",
        lambda: service(documents=[{"name": "private.pdf", "status": "ready"}]),
    )
    result = await selected_drive_status.inspect_selected_drive_files("private", context())
    assert result["status"] == "blocked"
    assert "private.pdf" not in str(result)
