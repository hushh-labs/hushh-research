"""Real SQL/HTTP copy lifecycle. Provider and object transport alone are synthetic."""

# ruff: noqa: F811 -- shared isolated PostgreSQL fixtures

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import httpx
import pytest
from fastapi import Header
from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import (
    DeliveryError,
    Package,
    Revoke,
    digest,
)
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from tests.drive_postgres_test_support import apply_drive_fixture_migration
from tests.helpers.document_delivery_client import (
    new_request,
    pay,
    stage,
)
from tests.services.test_document_delivery import (  # noqa: F401
    connector_postgres_url,
    delivery_app,
    delivery_system,
    documents,
    drive,
    drive_connect,
    lifecycle,
    sharing,
)
from tests.test_drive_sharing_routes import (
    BASE,
    REQUEST_ID,
    unlock,
)
from tests.test_drive_sharing_routes import (
    setup as sharing_route_setup,  # noqa: F401 -- canonical lightweight HTTP fixture
)


def _real_content_owner(app, monkeypatch):
    from api.middleware import require_vault_owner_token
    from api.routes import drive_sharing_owner
    from hushh_mcp.services import owner_placement_guard

    async def token(authorization: str = Header()):
        return {"user_id": authorization, "token": authorization}

    async def current(*, authorization, **_kwargs):
        return {"user_id": authorization.removeprefix("Bearer ")}

    app.dependency_overrides.pop(drive_sharing_owner._content_owner)
    app.dependency_overrides[require_vault_owner_token] = token
    monkeypatch.setattr(drive_sharing_owner, "require_vault_owner_token", current)
    placement = AsyncMock(return_value="byoc")
    monkeypatch.setattr(owner_placement_guard, "get_owner_hosting_mode", placement)
    monkeypatch.setattr(owner_placement_guard, "pod_mode", lambda: False)
    return placement


@pytest.mark.asyncio
async def test_source_selection_is_owner_only_and_placement_fresh(
    delivery_system, delivery_app, monkeypatch
):
    system = delivery_system
    request_id = (await new_request(system))["requestId"]
    path = f"/api/connectors/google_drive/sharing/requests/{request_id}/delivery"
    placement = _real_content_owner(delivery_app, monkeypatch)
    candidates = Mock(wraps=system.store._candidates)
    monkeypatch.setattr(system.store, "_candidates", candidates)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=delivery_app), base_url="https://one.invalid"
    ) as client:
        for actor in ("owner", "recipient"):
            terms = await client.get(path + "/terms", headers={"Authorization": actor})
            assert terms.status_code == 200 and terms.json()["files"] == []
        refused = await client.get(path + "/source-selection", headers={"Authorization": "owner"})
        assert refused.status_code == 409
        assert refused.json()["detail"]["code"] == "AGENT_PRIVATE_RUNTIME_REQUIRED"
        candidates.assert_not_called()
        placement.return_value = "shared"
        selected = await client.get(path + "/source-selection", headers={"Authorization": "owner"})
        assert selected.status_code == 200
        assert selected.json()["requestId"] == request_id and selected.json()["revision"] == 0
        assert selected.json()["files"][0]["providerFileId"] == "private-pdf-source"
        denied = await client.get(
            path + "/source-selection", headers={"Authorization": "recipient"}
        )
        assert denied.status_code == 404 and candidates.call_count == 1
        source_selection = system.store.source_selection

        async def moving_owner(**kwargs):
            result = await source_selection(**kwargs)
            placement.return_value = "byoc"
            return result

        monkeypatch.setattr(system.store, "source_selection", moving_owner)
        drifted = await client.get(path + "/source-selection", headers={"Authorization": "owner"})
        assert drifted.status_code == 409
        assert (
            "Private statement.pdf" not in drifted.text and "private-pdf-source" not in drifted.text
        )


@pytest.mark.asyncio
async def test_network_terms_and_controls_never_enumerate_sources(
    delivery_system, delivery_app, monkeypatch
):
    system = delivery_system
    request_id = (await new_request(system))["requestId"]
    staged = await stage(system, request_id)
    assert staged.prepared["files"][0]["providerFileId"] == "private-pdf-source"
    await pay(system, request_id, staged.package)
    placement = _real_content_owner(delivery_app, monkeypatch)
    candidates = Mock(side_effect=AssertionError("network reads cannot enumerate source files"))
    monkeypatch.setattr(system.store, "_candidates", candidates)
    path = f"/api/connectors/google_drive/sharing/requests/{request_id}/delivery"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=delivery_app), base_url="https://one.invalid"
    ) as client:
        for actor in ("owner", "recipient"):
            terms = await client.get(path + "/terms", headers={"Authorization": actor})
            assert terms.status_code == 200
            assert set(terms.json()["files"][0]) == {"fileRef", "name", "mimeType", "size"}
            assert "private-pdf-source" not in terms.text and "sourceRevision" not in terms.text
        released = await client.get(path + "/package", headers={"Authorization": "recipient"})
        assert released.status_code == 200 and released.json()["wraps"]
        owner_package = await client.get(
            path + "/owner-package", headers={"Authorization": "owner"}
        )
        assert owner_package.status_code == 200
        revoked = await client.post(
            path + "/revoke",
            headers={"Authorization": "owner"},
            json={"expectedRevision": 1, "idempotencyKey": str(uuid4()), "scope": "one"},
        )
        assert revoked.status_code == 200 and revoked.json()["status"] == "revoked"
        assert "private-pdf-source" not in revoked.text and "sourceRevision" not in revoked.text
    candidates.assert_not_called()
    placement.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["one", "both"])
async def test_hosted_contract_cannot_enter_legacy_grant_queue(delivery_system, mode):
    system = delivery_system
    request_id = (await new_request(system, mode))["requestId"]
    source = (await system.store.source_selection(request_id=request_id, actor="owner"))["files"][0]
    approval = SimpleNamespace(sources=[SimpleNamespace(document_id=source["documentId"])])
    with system.db.engine.begin() as connection:
        request = dict(
            connection.execute(
                text("SELECT * FROM drive_share_requests WHERE request_id=:id"),
                {"id": request_id},
            )
            .mappings()
            .one()
        )
        with pytest.raises(DriveSharingError, match="delivery_review_required"):
            system.store._queue_grants(
                connection,
                request=request,
                approval=approval,
                sources=[{"document_id": source["documentId"]}],
                batch="legacy-bypass-attempt",
                enforce_payment=False,
            )
        assert (
            connection.execute(
                text("SELECT COUNT(*) FROM drive_share_permission_operations WHERE request_id=:id"),
                {"id": request_id},
            ).scalar_one()
            == 0
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("content_type", ["application/vnd.test+json", None])
async def test_control_body_limit_is_independent_of_media_type(delivery_app, content_type):
    headers = {"Authorization": "owner"}
    if content_type is not None:
        headers["Content-Type"] = content_type
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=delivery_app), base_url="https://one.invalid"
    ) as client:
        response = await client.post(
            f"/api/connectors/google_drive/sharing/requests/{uuid4()}/delivery/approve",
            headers=headers,
            content=b"x" * 262145,
        )
    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "delivery_body_limit"


@pytest.mark.asyncio
async def test_private_bucket_qualification_refuses_policy_history_or_identity_changes():
    from hushh_mcp.services.document_delivery.storage import PrivateGcsCipherObjects
    from hushh_mcp.services.shared_files.bucket_admission import admission

    metadata = {
        "name": "synthetic-ciphertext",
        "generation": "1",
        "projectNumber": "123",
        "timeCreated": "2026-10-25T00:00:00.000Z",
        "metageneration": "1",
        "softDeletePolicy": {"retentionDurationSeconds": "0"},
        "iamConfiguration": {
            "uniformBucketLevelAccess": {"enabled": True},
            "publicAccessPrevention": "enforced",
        },
    }
    response = SimpleNamespace(status_code=200, json=lambda: metadata)
    transport = SimpleNamespace(_object_get=Mock(return_value=response), _session=Mock())
    objects = PrivateGcsCipherObjects(
        bucket=metadata["name"],
        identity=digest(admission(metadata, metadata["name"])["identity"]),
        store=transport,
    )
    await objects.qualify()
    # A current disabled policy cannot prove retained history after mutation.
    for field in ("metageneration", "generation"):
        metadata[field] = "2"
        with pytest.raises(DeliveryError, match="delivery_storage_unqualified"):
            await objects.remove("opaque-object", "11")
        metadata[field] = "1"
    metadata["iamConfiguration"]["publicAccessPrevention"] = "inherited"
    with pytest.raises(DeliveryError, match="delivery_storage_unqualified"):
        await objects.qualify()
    transport._session.delete.assert_not_called()


@pytest.mark.asyncio
async def test_real_sql_http_unpaid_recipient_and_revoke_fences(delivery_system, delivery_app):
    system = delivery_system
    created = await new_request(system)
    request_id = created["requestId"]
    staged = await stage(system, request_id)
    assert (
        await system.store.approve(request_id=request_id, actor="owner", body=staged.prepare_body)
        == staged.prepared
    )
    with pytest.raises(DeliveryError, match="payment_required"):
        await system.store.release(request_id=request_id, actor="recipient")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=delivery_app), base_url="https://one.invalid"
    ) as client:
        response = await client.get(
            f"/api/connectors/google_drive/sharing/requests/{request_id}/delivery/package",
            headers={"Authorization": "stranger"},
        )
        assert response.status_code == 404
        response = await client.get(
            f"/api/connectors/google_drive/sharing/requests/{request_id}/delivery/package",
            headers={"Authorization": "recipient"},
        )
        assert response.status_code == 402
        assert response.headers["cache-control"] == "private, no-store"
    with system.db.engine.begin() as connection:
        stored = (
            connection.execute(text("SELECT * FROM document_delivery_contracts")).mappings().one()
        )
        assert "Private statement.pdf" not in str(dict(stored))
        assert "private-pdf-source" not in str(dict(stored))
        cached = list(
            connection.execute(text("SELECT result FROM document_delivery_idempotency")).scalars()
        )
        assert cached and all(set(item) == {"version", "iv", "ciphertext"} for item in cached)
        assert "Private statement.pdf" not in str(cached)
        assert "private-pdf-source" not in str(cached)
        assert (
            connection.execute(
                text("SELECT COUNT(*) FROM drive_share_permission_operations")
            ).scalar()
            == 0
        )
    await system.store.revoke(
        request_id=request_id,
        actor="owner",
        body=Revoke.model_validate(
            {"expectedRevision": 1, "idempotencyKey": str(uuid4()), "scope": "one"}
        ),
    )
    with pytest.raises(DeliveryError, match="delivery_authority_ended"):
        await system.service.artifact(
            request_id=request_id, actor="owner", artifact_id=next(iter(staged.raw))
        )
    await system.service.cleanup()
    assert system.service.objects.objects == {}
    with system.db.engine.connect() as connection:
        assert (
            connection.execute(text("SELECT COUNT(*) FROM document_delivery_packages")).scalar()
            == 0
        )
        assert (
            connection.execute(text("SELECT COUNT(*) FROM document_delivery_idempotency")).scalar()
            == 0
        )
        assert (
            connection.execute(
                text("SELECT selection_envelope FROM document_delivery_contracts")
            ).scalar()
            is None
        )


@pytest.mark.asyncio
async def test_package_digest_substitution_never_publishes_unbound_wraps(delivery_system):
    system = delivery_system
    request_id = (await new_request(system))["requestId"]
    staged = await stage(system, request_id, publish=False)
    wrong = {**staged.package, "packageDigest": "f" * 64}
    with pytest.raises(DeliveryError, match="package_commitment_mismatch"):
        await system.store.stage_package(
            request_id=request_id, actor="owner", body=Package.model_validate(wrong)
        )
    with system.db.engine.connect() as connection:
        assert (
            connection.execute(text("SELECT COUNT(*) FROM document_delivery_packages")).scalar()
            == 0
        )
    current = await system.store.stage_package(
        request_id=request_id, actor="owner", body=Package.model_validate(staged.package)
    )
    assert current["status"] == "staged"


@pytest.mark.asyncio
async def test_migration_replay_refuses_loosened_identity_shape_and_rollback_is_guarded(
    delivery_system,
):
    from pathlib import Path

    from sqlalchemy.exc import DBAPIError

    system = delivery_system
    with (
        pytest.raises(DBAPIError, match="schema shape mismatch"),
        system.db.engine.begin() as connection,
    ):
        connection.execute(
            text(
                "ALTER TABLE document_delivery_contracts ALTER COLUMN recipient_key_fingerprint DROP NOT NULL"
            )
        )
        apply_drive_fixture_migration(connection, "424_protected_one_document_delivery.sql")
    await new_request(system)
    rollback = (
        Path(__file__).parents[2]
        / "db/migrations/rollback/424_protected_one_document_delivery.rollback.sql"
    ).read_text()
    with (
        pytest.raises(DBAPIError, match="reconcile retained document deliveries"),
        system.db.engine.begin() as connection,
    ):
        connection.exec_driver_sql(rollback.replace("%", "%%"))
    with system.db.engine.begin() as connection:
        from hushh_mcp.services.drive_sharing_retention import erase_drive_account_in_transaction

        erase_drive_account_in_transaction(
            connection, user_id="owner", permanent=True, cipher=system.store.sharing_cipher
        )
        connection.exec_driver_sql(rollback.replace("%", "%%"))
        apply_drive_fixture_migration(connection, "424_protected_one_document_delivery.sql")
        assert system.store.schema_ready(connection)


@pytest.mark.parametrize("operation", ["create", "projection"])
def test_hosted_routes_preserve_safe_shared_drive_errors(
    sharing_route_setup, monkeypatch, operation
):
    from api.middleware import require_firebase_auth_read_only
    from api.routes import document_delivery
    from hushh_mcp.services.google_drive_adapter import DriveReadError

    client, app, _, _ = sharing_route_setup
    app.include_router(document_delivery.router)
    service = SimpleNamespace(
        **{operation: AsyncMock(side_effect=DriveSharingError("connection_required"))}
    )
    monkeypatch.setattr(document_delivery, "_service", lambda: service)
    app.dependency_overrides[require_firebase_auth_read_only] = lambda: "recipient"
    body = {
        "version": 1,
        "ownerUserId": "owner",
        "clientRequestId": REQUEST_ID,
        "purpose": {"purpose": "resume", "periodStart": "2026-06-02", "periodEnd": "2026-10-02"},
        "receiveThrough": "one",
        "activityDisclosureVersion": "one-document-activity-v1",
        "activityAccepted": True,
        "recipientKeyId": "key-test",
        "recipientKeyFingerprint": "a" * 64,
    }

    def request():
        if operation == "create":
            return client.post(
                "/api/connectors/google_drive/sharing/delivery-requests",
                headers={"Authorization": "Bearer synthetic-firebase"},
                json=body,
            )
        return client.get(BASE + f"/{REQUEST_ID}/delivery/terms")

    # The transport fix does not bypass admission or invoke the domain service.
    assert request().status_code == 401
    assert not getattr(service, operation).called
    unlock(app)
    response = request()
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "connection_required"
    assert "no-store" in response.headers["Cache-Control"]
    # Arbitrary provider text still cannot cross the shared closed-code mapper.
    getattr(service, operation).side_effect = DriveReadError("private-provider-diagnostic")
    response = request()
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "sharing_unavailable"
    assert "private-provider-diagnostic" not in response.text
