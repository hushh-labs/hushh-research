from __future__ import annotations

import base64
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from hushh_mcp.services.external_connector_credentials_service import (
    ExternalConnectorCredentialError,
    ExternalConnectorCredentialsService,
)

# Generated, not a literal, so no fixed-looking key value sits in source
# control for a secret scanner to flag.
_TEST_KEY = base64.urlsafe_b64encode(b"\x00" * 16).decode()


class _FakeConnectionsDb:
    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], dict] = {}

    def execute_raw(self, sql: str, params: dict | None):
        params = params or {}
        if "INSERT INTO user_external_connector_connections" in sql:
            key = (params["user_id"], params["connector_id"])
            self.rows[key] = {
                "user_id": params["user_id"],
                "connector_id": params["connector_id"],
                "status": "connected",
                "credential_ciphertext": params["ciphertext"],
                "credential_iv": params["iv"],
                "connected_account_label": params.get("account_label"),
                "connected_at": params["now"],
                "last_error_code": None,
            }
            return SimpleNamespace(data=[{"user_id": params["user_id"]}])
        if sql.strip().startswith("SELECT") and "WHERE user_id = :user_id AND connector_id" in sql:
            key = (params["user_id"], params["connector_id"])
            row = self.rows.get(key)
            return SimpleNamespace(data=[row] if row else [])
        if sql.strip().startswith("SELECT") and "WHERE user_id = :user_id" in sql:
            matches = [row for (uid, _cid), row in self.rows.items() if uid == params["user_id"]]
            return SimpleNamespace(data=matches)
        if sql.strip().startswith("UPDATE"):
            key = (params["user_id"], params["connector_id"])
            row = self.rows.get(key)
            if row is not None:
                row["status"] = "revoked"
                row["credential_ciphertext"] = None
                row["credential_iv"] = None
            return SimpleNamespace(data=[{"user_id": params["user_id"]}] if row else [])
        raise AssertionError(f"unexpected SQL in fake db: {sql}")


@pytest.fixture(autouse=True)
def _credential_key(shared_hub_owner, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EXTERNAL_CONNECTOR_CREDENTIAL_KEY", _TEST_KEY)


@pytest.mark.asyncio
async def test_store_then_get_round_trips_the_secret() -> None:
    service = ExternalConnectorCredentialsService(db=_FakeConnectionsDb())

    await service.store_credential(
        user_id="user_1",
        connector_id="notion",
        secret={"accessToken": "tok_abc"},
        account_label="me@example.com",
    )
    credential = await service.get_credential(user_id="user_1", connector_id="notion")

    assert credential == {"accessToken": "tok_abc"}


@pytest.mark.asyncio
async def test_get_credential_returns_none_when_never_connected() -> None:
    service = ExternalConnectorCredentialsService(db=_FakeConnectionsDb())

    credential = await service.get_credential(user_id="user_1", connector_id="notion")

    assert credential is None


@pytest.mark.asyncio
async def test_ciphertext_is_bound_to_its_own_user_and_connector() -> None:
    db = _FakeConnectionsDb()
    service = ExternalConnectorCredentialsService(db=db)
    await service.store_credential(
        user_id="user_1", connector_id="notion", secret={"accessToken": "tok_abc"}
    )
    # Simulate the ciphertext being read back under a different AAD, e.g. a
    # bug that mixed up whose row this is -- must fail closed, not decrypt.
    row = db.rows[("user_1", "notion")]
    db.rows[("user_2", "notion")] = dict(row)

    with pytest.raises(ExternalConnectorCredentialError):
        await service.get_credential(user_id="user_2", connector_id="notion")


@pytest.mark.asyncio
async def test_disconnect_clears_the_ciphertext_and_marks_revoked() -> None:
    db = _FakeConnectionsDb()
    service = ExternalConnectorCredentialsService(db=db)
    await service.store_credential(user_id="user_1", connector_id="notion", secret={"apiKey": "k"})

    await service.disconnect(user_id="user_1", connector_id="notion")

    assert await service.get_credential(user_id="user_1", connector_id="notion") is None
    status = await service.status(user_id="user_1", connector_id="notion")
    assert status["status"] == "revoked"


@pytest.mark.asyncio
async def test_list_statuses_covers_every_connector_for_the_user() -> None:
    db = _FakeConnectionsDb()
    service = ExternalConnectorCredentialsService(db=db)
    await service.store_credential(user_id="user_1", connector_id="notion", secret={"apiKey": "a"})
    await service.store_credential(user_id="user_1", connector_id="hubspot", secret={"apiKey": "b"})
    await service.store_credential(user_id="user_2", connector_id="notion", secret={"apiKey": "c"})

    statuses = await service.list_statuses(user_id="user_1")

    assert {row["connectorId"] for row in statuses} == {"notion", "hubspot"}


@pytest.mark.asyncio
async def test_missing_key_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EXTERNAL_CONNECTOR_CREDENTIAL_KEY", raising=False)
    service = ExternalConnectorCredentialsService(db=_FakeConnectionsDb())

    with pytest.raises(ExternalConnectorCredentialError):
        await service.store_credential(user_id="user_1", connector_id="notion", secret={})


def versioned_row(service):
    expiry = datetime.now(UTC) + timedelta(hours=1)
    sealed = service.seal_credential(
        user_id="owner",
        connector_id="google_drive",
        generation=2,
        version=3,
        secret={"accessToken": "synthetic", "subject": "verified-subject"},
        expires_at=expiry,
    )
    return dict(
        credential_ciphertext=sealed["ciphertext"],
        credential_iv=sealed["iv"],
        credential_expires_at=expiry,
        connection_generation=2,
        credential_version=3,
        envelope_version=2,
    )


@pytest.mark.feature_account_deletion
@pytest.mark.trace_loop
@pytest.mark.parametrize("json_snapshot", [False, True])
def test_v2_encrypts_identity_and_roundtrips_without_plaintext_fields(json_snapshot):
    service = ExternalConnectorCredentialsService(db=_FakeConnectionsDb())
    row = versioned_row(service)
    if json_snapshot:
        row["credential_expires_at"] = row["credential_expires_at"].isoformat()
    assert "synthetic" not in str(row)
    assert "verified-subject" not in str(row)
    assert service.open_credential(user_id="owner", connector_id="google_drive", row=row) == {
        "accessToken": "synthetic",
        "subject": "verified-subject",
    }


@pytest.mark.parametrize(
    "field,value",
    [
        ("user_id", "other"),
        ("connector_id", "other"),
        ("connection_generation", 3),
        ("credential_version", 4),
        ("envelope_version", 1),
        ("credential_expires_at", datetime(2030, 1, 1, tzinfo=UTC)),
        ("credential_expires_at", "2030-01-01T00:00:00+00:00"),
    ],
)
def test_v2_rejects_owner_connector_generation_version_or_expiry_substitution(field, value):
    service = ExternalConnectorCredentialsService(db=_FakeConnectionsDb())
    row = versioned_row(service)
    context = dict(user_id="owner", connector_id="google_drive")
    if field in context:
        context[field] = value
    else:
        row[field] = value
    with pytest.raises(ExternalConnectorCredentialError, match="needs reauthorization"):
        service.open_credential(**context, row=row)


@pytest.mark.asyncio
async def test_private_credentials_refuse_before_storage_or_opening(shared_hub_owner, monkeypatch):
    from unittest.mock import Mock

    from fastapi import HTTPException

    db = _FakeConnectionsDb()
    service = ExternalConnectorCredentialsService(db=db)
    await service.store_credential(
        user_id="owner", connector_id="notion", secret={"apiKey": "synthetic"}
    )
    previous = dict(db.rows)
    shared_hub_owner.return_value = "byoc"
    opening = Mock(side_effect=AssertionError("Private credential must remain sealed"))
    monkeypatch.setattr(service, "open_credential", opening)
    with pytest.raises(HTTPException) as error:
        await service.get_credential(user_id="owner", connector_id="notion")
    assert error.value.status_code == 409
    with pytest.raises(HTTPException):
        await service.store_credential(
            user_id="owner", connector_id="notion", secret={"apiKey": "replacement"}
        )
    assert db.rows == previous
    assert (await service.status(user_id="owner", connector_id="notion"))["accountLabel"] is None
    opening.assert_not_called()
    assert (await service.disconnect(user_id="owner", connector_id="notion"))["status"] == "revoked"


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", ["fetch", "publish"])
async def test_ingestion_placement_change_blocks_processing_and_publication(
    shared_hub_owner, boundary
):
    from unittest.mock import AsyncMock, Mock

    from hushh_mcp.services.drive_ingestion_service import DriveIngestionService
    from hushh_mcp.services.google_drive_adapter import DriveContent, DriveMetadata

    metadata = DriveMetadata(
        "synthetic", "synthetic", "text/plain", "1", "2026-10-10T00:00:00Z", 4, None
    )
    job = {"user_id": "owner", "connection_generation": 1}

    async def changed(value):
        shared_hub_owner.return_value = "byoc"
        return value

    store = SimpleNamespace(
        claim=AsyncMock(return_value=job),
        current=AsyncMock(),
        stage=AsyncMock(),
        fail=AsyncMock(),
        publish=AsyncMock(),
        cipher=SimpleNamespace(open=lambda _: {"file_id": "synthetic"}),
    )
    processor = SimpleNamespace(prepare=AsyncMock(return_value=SimpleNamespace(validate=Mock())))
    adapter = SimpleNamespace(
        fetch_content=AsyncMock(return_value=DriveContent(metadata, "text/plain", b"test")),
        get_metadata=AsyncMock(return_value=metadata),
    )

    async def changed_fetch(**_):
        return await changed(DriveContent(metadata, "text/plain", b"test"))

    async def changed_metadata(**_):
        return await changed(metadata)

    if boundary == "fetch":
        adapter.fetch_content.side_effect = changed_fetch
    else:
        adapter.get_metadata.side_effect = changed_metadata
    oauth = SimpleNamespace(
        lifecycle=SimpleNamespace(read=AsyncMock(return_value={"connection_generation": 1})),
        current_credential=AsyncMock(
            return_value=({"connection_generation": 1}, {"accessToken": "synthetic"})
        ),
    )
    result = await DriveIngestionService(
        processor=processor, store=store, adapter=adapter, oauth=oauth
    ).run_one(user_id="owner")
    assert result == {"status": "not_ready"}
    store.publish.assert_not_awaited()
    assert processor.prepare.await_count == (0 if boundary == "fetch" else 1)


@pytest.mark.asyncio
async def test_picker_pending_rechecks_after_storage_before_opening(shared_hub_owner, monkeypatch):
    from unittest.mock import AsyncMock, Mock

    from fastapi import HTTPException

    from hushh_mcp.services.drive_native_picker_service import DriveNativePickerService

    async def pending(**_):
        shared_hub_owner.return_value = "byoc"
        return {"attempt_id": "synthetic"}

    picker = DriveNativePickerService(
        oauth=SimpleNamespace(),
        store=SimpleNamespace(pending=AsyncMock(side_effect=pending)),
        adapter=SimpleNamespace(),
        selection=SimpleNamespace(),
    )
    opening = Mock(side_effect=AssertionError("must remain sealed"))
    monkeypatch.setattr(picker, "_open_candidates", opening)
    with pytest.raises(HTTPException) as refused:
        await picker.pending(user_id="owner")
    assert refused.value.status_code == 409
    opening.assert_not_called()


@pytest.mark.asyncio
async def test_curated_refresh_join_refuses_changed_placement_before_opening(
    shared_hub_owner, monkeypatch
):
    from unittest.mock import AsyncMock, Mock

    from fastapi import HTTPException

    import hushh_mcp.services.external_connector_curated_oauth as module
    from hushh_mcp.services.external_connector_curated_oauth import ExternalConnectorCuratedOAuth

    async def read(**_):
        shared_hub_owner.return_value = "byoc"
        return {
            "connection_generation": 1,
            "status": "connected",
            "credential_expires_at": datetime.now(UTC) + timedelta(hours=1),
        }

    monkeypatch.setattr(module.asyncio, "sleep", AsyncMock())
    opening = Mock(side_effect=AssertionError("must remain sealed"))
    service = ExternalConnectorCuratedOAuth(
        registry=SimpleNamespace(),
        credentials=SimpleNamespace(open_credential=opening),
        lifecycle=SimpleNamespace(read=AsyncMock(side_effect=read)),
        state_codec=SimpleNamespace(),
    )
    with pytest.raises(HTTPException) as refused:
        await service._await_concurrent_refresh(
            user_id="owner", connector_id="synthetic", generation=1, client_id="synthetic"
        )
    assert refused.value.status_code == 409
    opening.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("cleanup", [False, True])
async def test_google_refresh_dispatch_refuses_private_execution_but_preserves_cleanup(
    shared_hub_owner, cleanup
):
    from unittest.mock import AsyncMock, Mock

    from fastapi import HTTPException

    from hushh_mcp.services.google_connector_credential_execution import _refresh

    async def claim(**_):
        shared_hub_owner.return_value = "byoc"
        return True

    row = {"connection_generation": 1, "credential_version": 1, "status": "connected"}
    service = SimpleNamespace(
        lifecycle=SimpleNamespace(
            claim_refresh=AsyncMock(side_effect=claim),
            settle_refresh=AsyncMock(return_value=True),
            read=AsyncMock(return_value=row),
        ),
        _post=AsyncMock(return_value={}),
        _token_fields=Mock(
            return_value={"expiresAt": (datetime.now(UTC) + timedelta(hours=1)).isoformat()}
        ),
        credentials=SimpleNamespace(
            seal_credential=Mock(return_value={}),
            open_credential=Mock(return_value={"accessToken": "synthetic"}),
        ),
    )
    call = _refresh(
        service,
        user_id="owner",
        row=row,
        credential={"refreshToken": "synthetic"},
        profile="selected",
        client_id="synthetic",
        client_secret="synthetic",  # noqa: S106 -- synthetic fixture
        cleanup=cleanup,
    )
    if cleanup:
        assert (await call)[0] == row
        service._post.assert_awaited_once()
    else:
        with pytest.raises(HTTPException) as refused:
            await call
        assert refused.value.status_code == 409
        service._post.assert_not_awaited()
        service.credentials.seal_credential.assert_not_called()
    service.lifecycle.settle_refresh.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["google", "curated"])
async def test_code_exchange_rechecks_placement_after_configuration(
    shared_hub_owner, monkeypatch, provider
):
    from unittest.mock import AsyncMock, Mock

    from fastapi import HTTPException

    from hushh_mcp.services import external_connector_google_oauth as google
    from hushh_mcp.services.external_connector_curated_oauth import ExternalConnectorCuratedOAuth

    credentials = SimpleNamespace(
        decrypt_secret=Mock(side_effect=AssertionError("must remain sealed"))
    )
    codec = SimpleNamespace(_verify_state=lambda _: "synthetic")
    lifecycle = SimpleNamespace(
        claim_attempt=AsyncMock(return_value={"user_id": "owner", "connector_id": "google_drive"})
    )
    if provider == "google":
        service = google.ExternalConnectorGoogleOAuth(
            db=SimpleNamespace(),
            registry=SimpleNamespace(),
            credentials=credentials,
            state_codec=codec,
            lifecycle=lifecycle,
        )
        monkeypatch.setattr(google, "connector_feature_enabled", lambda *_: True)
    else:
        service = ExternalConnectorCuratedOAuth(
            registry=SimpleNamespace(),
            credentials=credentials,
            state_codec=codec,
            lifecycle=lifecycle,
        )

    async def configuration(*_):
        shared_hub_owner.return_value = "byoc"
        return SimpleNamespace(), "synthetic", "synthetic"

    service._configuration = AsyncMock(side_effect=configuration)
    service._post = AsyncMock()
    with pytest.raises(HTTPException) as refused:
        await service._exchange(state="synthetic", code="synthetic", owner="owner")
    assert refused.value.status_code == 409
    service._post.assert_not_awaited()
    credentials.decrypt_secret.assert_not_called()
