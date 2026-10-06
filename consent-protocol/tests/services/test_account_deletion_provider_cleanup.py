"""Provider-side grant release for a committed account deletion."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from hushh_mcp.services import account_deletion_provider_cleanup as cleanup
from hushh_mcp.services.account_deletion_provider_cleanup import (
    ProviderCredentialSnapshot,
    release_provider_grants_after_erasure,
    snapshot_provider_credentials_in_transaction,
)
from hushh_mcp.services.gmail_receipts_service import GmailReceiptsService
from hushh_mcp.services.google_connection_service import GoogleConnectionService

_KEY = b"k" * 32


def _snapshot(**rows) -> ProviderCredentialSnapshot:
    return ProviderCredentialSnapshot(
        user_id="uid_1", rows={source: tuple(value) for source, value in rows.items()}
    )


def _conn_returning(rows_by_table: dict[str, list[dict]]):
    conn = MagicMock()

    def execute(statement, params):
        sql = str(statement)
        table = next(name for name in rows_by_table if f"FROM {name} " in sql)
        result = MagicMock()
        result.mappings.return_value = [{"row": row} for row in rows_by_table[table]]
        return result

    conn.execute.side_effect = execute
    return conn


def test_snapshot_reads_only_the_owner_rows_under_a_savepoint():
    conn = _conn_returning(
        {
            "google_provider_connections": [{"refresh_token_ciphertext": "c1"}],
            "kai_gmail_connections": [],
            "user_external_connector_connections": [{"connector_id": "google_drive"}],
        }
    )

    snapshot = snapshot_provider_credentials_in_transaction(
        conn, user_id="uid_1", table_exists=lambda _table: True
    )

    conn.begin_nested.assert_called_once()
    assert snapshot.collection_failed is False
    assert snapshot.rows["google_connection"] == ({"refresh_token_ciphertext": "c1"},)
    assert snapshot.rows["external_connector"] == ({"connector_id": "google_drive"},)
    assert all(call.args[1] == {"user_id": "uid_1"} for call in conn.execute.call_args_list)
    assert "c1" not in repr(snapshot)


def test_snapshot_skips_absent_tables_and_never_raises():
    conn = MagicMock()
    conn.execute.side_effect = RuntimeError("column missing")

    assert snapshot_provider_credentials_in_transaction(
        conn, user_id="uid_1", table_exists=lambda _table: False
    ).is_empty
    failed = snapshot_provider_credentials_in_transaction(
        conn, user_id="uid_1", table_exists=lambda _table: True
    )
    assert failed.collection_failed is True


async def test_release_without_grants_makes_no_provider_calls(monkeypatch):
    revoke = AsyncMock()
    monkeypatch.setattr(cleanup, "revoke_google_oauth_token", revoke)

    assert await release_provider_grants_after_erasure(_snapshot()) == {
        "status": "no_provider_grants"
    }
    assert await release_provider_grants_after_erasure(
        ProviderCredentialSnapshot(user_id="uid_1", collection_failed=True)
    ) == {"status": "snapshot_failed"}
    revoke.assert_not_awaited()


async def test_release_revokes_google_and_verified_drive_grants_only(monkeypatch):
    revoke = AsyncMock(return_value="revoked")
    monkeypatch.setattr(cleanup, "revoke_google_oauth_token", revoke)
    google = MagicMock()
    google.refresh_token_for_erasure.return_value = "google-refresh"
    monkeypatch.setattr(
        "hushh_mcp.services.google_connection_service.get_google_connection_service",
        lambda: google,
    )
    credentials = MagicMock()
    credentials.open_credential.return_value = {"refreshToken": "drive-refresh"}
    monkeypatch.setattr(
        "hushh_mcp.services.external_connector_credentials_service."
        "get_external_connector_credentials_service",
        lambda: credentials,
    )

    outcome = await release_provider_grants_after_erasure(
        _snapshot(
            google_connection=[{"refresh_token_ciphertext": "c"}],
            external_connector=[
                {
                    "connector_id": "google_drive",
                    "envelope_version": 2,
                    "credential_ciphertext": "x",
                },
                {
                    "connector_id": "google_drive",
                    "envelope_version": 1,
                    "credential_ciphertext": "x",
                },
                {"connector_id": "hubspot", "envelope_version": 2, "credential_ciphertext": "x"},
            ],
        )
    )

    assert outcome["status"] == "attempted"
    assert outcome["google_connection"] == ["revoked"]
    assert outcome["external_connectors"] == ["revoked", "not_applicable", "not_applicable"]
    assert sorted(call.args[0] for call in revoke.await_args_list) == [
        "drive-refresh",
        "google-refresh",
    ]
    credentials.open_credential.assert_called_once()


async def test_release_is_bounded_and_never_raises(monkeypatch):
    async def hang(_snapshot):
        await asyncio.sleep(60)

    async def boom(_snapshot):
        raise RuntimeError("provider down")

    monkeypatch.setattr(cleanup, "_release_google_connections", hang)
    assert await release_provider_grants_after_erasure(
        _snapshot(google_connection=[{"x": 1}]), timeout_seconds=0.05
    ) == {"status": "timed_out"}

    monkeypatch.setattr(cleanup, "_release_google_connections", boom)
    outcome = await release_provider_grants_after_erasure(_snapshot(google_connection=[{"x": 1}]))
    assert outcome["google_connection"] == "failed"


def test_google_refresh_token_for_erasure_decrypts_only_its_own_envelope(monkeypatch):
    service = GoogleConnectionService(db=MagicMock())
    monkeypatch.setattr(service, "_token_key", lambda: _KEY)
    envelope = service._encrypt("refresh-secret", aad="google-connection:uid_1")
    row = {"refresh_token_ciphertext": envelope["ciphertext"], "refresh_token_iv": envelope["iv"]}

    assert service.refresh_token_for_erasure(row, user_id="uid_1") == "refresh-secret"
    assert service.refresh_token_for_erasure(row, user_id="someone_else") is None
    assert service.refresh_token_for_erasure({}, user_id="uid_1") is None


def _gmail_row(service: GmailReceiptsService, *, access_expires_in: timedelta, watch_status: str):
    refresh = service._encrypt_token("gmail-refresh")
    access = service._encrypt_token("gmail-access")
    return {
        "refresh_token_ciphertext": refresh["ciphertext"],
        "refresh_token_iv": refresh["iv"],
        "refresh_token_tag": refresh["tag"],
        "access_token_ciphertext": access["ciphertext"],
        "access_token_iv": access["iv"],
        "access_token_tag": access["tag"],
        "access_token_expires_at": (datetime.now(UTC) + access_expires_in).isoformat(),
        "watch_status": watch_status,
        "watch_expiration_at": (datetime.now(UTC) + timedelta(days=3)).isoformat(),
    }


@pytest.fixture
def gmail(monkeypatch) -> GmailReceiptsService:
    service = GmailReceiptsService()
    monkeypatch.setattr(service, "_token_key", lambda: _KEY)
    return service


async def test_gmail_erasure_stops_a_live_watch_before_revoking(gmail, monkeypatch):
    order: list[str] = []
    post_json = AsyncMock(side_effect=lambda url, **_: order.append(url) or {})
    post_form = AsyncMock(side_effect=lambda url, data, headers=None: order.append(url) or {})
    monkeypatch.setattr(gmail, "_http_post_json", post_json)
    monkeypatch.setattr(gmail, "_http_post_form", post_form)

    outcome = await gmail.stop_watch_and_revoke_for_erasure(
        _gmail_row(gmail, access_expires_in=timedelta(minutes=30), watch_status="active")
    )

    assert outcome == {"gmail_watch": "stopped", "gmail_grant": "revoked"}
    assert order == [
        "https://gmail.googleapis.com/gmail/v1/users/me/stop",
        "https://oauth2.googleapis.com/revoke",
    ]
    assert post_json.await_args.kwargs["token"] == "gmail-access"
    assert post_form.await_args.args[1] == {"token": "gmail-refresh"}


async def test_gmail_erasure_refreshes_an_expired_access_token_for_stop(gmail, monkeypatch):
    refresh = AsyncMock(return_value={"access_token": "fresh-access"})
    post_json = AsyncMock(return_value={})
    monkeypatch.setattr(gmail, "_refresh_access_token", refresh)
    monkeypatch.setattr(gmail, "_http_post_json", post_json)
    monkeypatch.setattr(gmail, "_http_post_form", AsyncMock(return_value={}))

    outcome = await gmail.stop_watch_and_revoke_for_erasure(
        _gmail_row(gmail, access_expires_in=timedelta(minutes=-5), watch_status="active")
    )

    refresh.assert_awaited_once_with(refresh_token="gmail-refresh")  # noqa: S106
    assert post_json.await_args.kwargs["token"] == "fresh-access"
    assert outcome["gmail_watch"] == "stopped"


async def test_gmail_erasure_reports_failures_without_raising(gmail, monkeypatch):
    monkeypatch.setattr(gmail, "_http_post_json", AsyncMock(side_effect=RuntimeError("503")))
    monkeypatch.setattr(gmail, "_http_post_form", AsyncMock(side_effect=RuntimeError("503")))

    outcome = await gmail.stop_watch_and_revoke_for_erasure(
        _gmail_row(gmail, access_expires_in=timedelta(minutes=30), watch_status="active")
    )

    assert outcome == {"gmail_watch": "failed", "gmail_grant": "failed"}


async def test_gmail_erasure_skips_stop_when_no_watch_is_live(gmail, monkeypatch):
    post_json = AsyncMock()
    monkeypatch.setattr(gmail, "_http_post_json", post_json)
    monkeypatch.setattr(gmail, "_http_post_form", AsyncMock(return_value={}))
    row = _gmail_row(gmail, access_expires_in=timedelta(minutes=30), watch_status="expired")
    row["watch_expiration_at"] = (datetime.now(UTC) - timedelta(days=1)).isoformat()

    outcome = await gmail.stop_watch_and_revoke_for_erasure(row)

    post_json.assert_not_awaited()
    assert outcome == {"gmail_watch": "not_active", "gmail_grant": "revoked"}


# --- curated providers that publish a revocation endpoint (Notion) ---------------


@pytest.fixture
def notion(monkeypatch):
    from hushh_mcp.services import external_connector_curated_oauth as curated

    post = AsyncMock()
    monkeypatch.setattr(curated, "post_revocation", post)
    monkeypatch.setenv("NOTION_OAUTH_CLIENT_ID", "client-1")
    credentials = MagicMock()
    credentials.open_credential.return_value = {
        "refreshToken": "notion-refresh",
        "accessToken": "notion-access",
        "oauthClientId": "client-1",
    }
    monkeypatch.setattr(
        "hushh_mcp.services.external_connector_credentials_service."
        "get_external_connector_credentials_service",
        lambda: credentials,
    )
    return SimpleNamespace(post=post, credentials=credentials)


def _notion_row(**overrides):
    return {
        "connector_id": "notion",
        "envelope_version": 2,
        "credential_ciphertext": "x",
        **overrides,
    }


async def _release(*rows):
    outcome = await release_provider_grants_after_erasure(_snapshot(external_connector=list(rows)))
    return outcome["external_connectors"]


async def test_deletion_revokes_a_notion_grant_at_the_provider(notion):
    assert await _release(_notion_row()) == ["revoked"]
    notion.post.assert_awaited_once_with(
        url="https://mcp.notion.com/token",
        data={
            "token": "notion-refresh",
            "token_type_hint": "refresh_token",
            "client_id": "client-1",
        },
    )


async def test_deletion_falls_back_to_the_access_token(notion):
    notion.credentials.open_credential.return_value = {
        "accessToken": "notion-access",
        "oauthClientId": "client-1",
    }
    assert await _release(_notion_row()) == ["revoked"]
    data = notion.post.await_args.kwargs["data"]
    assert data["token"] == "notion-access" and data["token_type_hint"] == "access_token"


async def test_a_credential_without_a_token_is_not_sent_anywhere(notion):
    notion.credentials.open_credential.return_value = {"oauthClientId": "client-1"}
    assert await _release(_notion_row()) == ["none"]
    notion.post.assert_not_awaited()


@pytest.mark.parametrize(
    "case",
    ["client_changed", "client_not_mounted", "unreadable", "provider_refused"],
)
async def test_an_unverifiable_or_refused_grant_is_reported_failed_and_never_raises(
    notion, monkeypatch, case
):
    if case == "client_changed":
        notion.credentials.open_credential.return_value = {
            "refreshToken": "notion-refresh",
            "oauthClientId": "another-client",
        }
    elif case == "client_not_mounted":
        monkeypatch.delenv("NOTION_OAUTH_CLIENT_ID")
    elif case == "unreadable":
        notion.credentials.open_credential.side_effect = RuntimeError("PRIVATE_DECRYPT_DETAIL")
    else:
        notion.post.side_effect = RuntimeError("provider down")
    assert await _release(_notion_row()) == ["failed"]
    if case != "provider_refused":
        notion.post.assert_not_awaited()


async def test_a_legacy_envelope_or_a_provider_with_no_endpoint_is_never_sent(notion):
    outcomes = await _release(
        _notion_row(envelope_version=1),
        {"connector_id": "attio", "envelope_version": 2, "credential_ciphertext": "x"},
    )
    assert outcomes == ["not_applicable", "not_applicable"]
    notion.post.assert_not_awaited()


async def test_a_failure_log_names_the_provider_and_class_but_not_the_detail(notion, caplog):
    notion.credentials.open_credential.side_effect = RuntimeError("PRIVATE_DECRYPT_DETAIL")
    with caplog.at_level("WARNING"):
        await _release(_notion_row())
    assert "provider=notion" in caplog.text and "RuntimeError" in caplog.text
    assert "PRIVATE_DECRYPT_DETAIL" not in caplog.text
