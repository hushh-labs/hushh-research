"""Real SQL: additive copies share one legacy sale. Only providers are fake."""

# ruff: noqa: F401, F811 -- canonical isolated PostgreSQL fixtures

import hashlib
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import text

from api.routes import document_delivery_background as routes
from api.routes.drive_sharing import CreateRequest
from api.routes.drive_sharing_owner import _content_owner, _owner
from hushh_mcp.services.document_delivery import background_access
from hushh_mcp.services.document_delivery.background_consent import ACTIVITY, request_terms
from hushh_mcp.services.document_delivery.background_service import BackgroundCopyService
from hushh_mcp.services.document_delivery.background_source import (
    CHUNK_BYTES,
    content_identity,
    require_original,
)
from hushh_mcp.services.document_delivery.background_store import BackgroundCopyStore
from hushh_mcp.services.document_delivery.contracts import DeliveryError
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from tests.drive_postgres_test_support import apply_drive_fixture_migration
from tests.helpers.document_delivery_setup import CipherObjects
from tests.services.test_drive_autoshare_pay_then_stream_postgres import (
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    flow,
    lifecycle,
    request_bulk,
    sharing,
)

pytestmark = pytest.mark.feature_protected_documents


class Original:
    """Transport fixture: binary larger than the former 4 MiB limit."""

    data = b"const resume = 'fixture';\n" * 190000
    facts_value = None
    reads = 0

    async def facts(self, source, credential):
        return {
            **self.facts_value,
            "id": source["id"],
            "title": source["name"],
            "mimeType": source["mimeType"],
            "version": "999",
            "capabilities": {"canDownload": True},
        }

    async def chunk(self, source, credential, offset, size):
        self.reads += 1
        return bytearray(self.data[offset : offset + CHUNK_BYTES])


@pytest.fixture
async def copies(flow, monkeypatch):
    with flow.db.engine.connect() as connection:
        apply_drive_fixture_migration(connection, "432_document_delivery_background.sql")
        # Repeatability must not loosen receipt or consent constraints.
        apply_drive_fixture_migration(connection, "432_document_delivery_background.sql")
        apply_drive_fixture_migration(
            connection, "rollback/432_document_delivery_background.rollback.sql"
        )
        apply_drive_fixture_migration(connection, "432_document_delivery_background.sql")
        connection.commit()
    monkeypatch.setattr(
        "hushh_mcp.services.owner_placement_guard.get_owner_hosting_mode",
        AsyncMock(return_value="shared"),
    )
    create = flow.sharing.create_request

    async def create_copy(**kwargs):
        return await create(
            **kwargs, one_copy_requested=True, activity_accepted=True, activity_disclosure=ACTIVITY
        )

    monkeypatch.setattr(flow.sharing, "create_request", create_copy)
    original = Original()
    seal = flow.bulk._seal

    def provider_metadata(value, **kwargs):
        if kwargs.get("purpose") == "owner-search-result":
            mime = getattr(original, "mime_type", "application/javascript")
            original.facts_value = {"modifiedTime": value["modifiedTime"], "version": "1"}
            if not mime.startswith("application/vnd.google-apps."):
                original.facts_value.update(
                    {
                        "size": len(original.data),
                        "md5Checksum": hashlib.md5(
                            original.data, usedforsecurity=False
                        ).hexdigest(),
                        "sha256Checksum": hashlib.sha256(original.data).hexdigest(),
                        "headRevisionId": "content-revision-1",
                    }
                )
            from hushh_mcp.services.document_delivery.background_source import content_evidence

            value = {
                **value,
                "mimeType": mime,
                "sourceVersion": "1",
                **content_evidence({**original.facts_value, "mimeType": mime}),
            }
        return seal(value, **kwargs)

    monkeypatch.setattr(flow.bulk, "_seal", provider_metadata)
    service = BackgroundCopyService(
        store=BackgroundCopyStore(db=flow.db, sharing_cipher=flow.bulk.cipher),
        objects=CipherObjects(),
        reader=original,
        oauth=SimpleNamespace(
            current_credential=AsyncMock(
                return_value=({"connection_generation": 1}, {"accessToken": "synthetic-only"})
            )
        ),
    )
    return service, original


async def sale(flow, *, accept=True, paid=True):
    created = await flow.request(trusted=False, allow=False)
    if not accept:
        with pytest.raises(DriveSharingError, match="invalid_argument"):
            await flow.sharing.allow_request(
                user_id="owner",
                request_id=flow.request_id,
                revision=created["revision"],
                amount_cents=1000,
                one_copy_accepted=accept,
            )
        return
    await flow.sharing.allow_request(
        user_id="owner",
        request_id=flow.request_id,
        revision=created["revision"],
        amount_cents=1000,
        one_copy_accepted=accept,
    )
    await flow.start_search()
    await flow.page(1)
    await flow.finish()
    await flow.drain()
    await flow.checkout()
    if paid:
        await flow.pay()
        await flow.drain()
        assert await flow.grant_all() == 1, (
            flow.request_status(),
            flow.batches(),
            flow.search_status(),
        )


@pytest.mark.asyncio
async def test_same_paid_sale_generic_original_stream_and_revoke(flow, copies, monkeypatch):
    service, original = copies
    await sale(flow)
    original_order, original_effect_count = flow.order(), flow.effect_count()
    assert len(original.data) > 4 * 1024 * 1024
    assert (await service.run())["outcomes"] == {"released": 1}
    assert (await service.run())["outcomes"] == {}
    projection = await background_access.status(
        service, request_id=flow.request_id, actor="recipient"
    )
    assert projection["status"] == "ready"
    file = projection["files"][0]
    assert file["mimeType"] == "application/javascript" and not file["previewAvailable"]
    assert file["sha256"] == hashlib.sha256(original.data).hexdigest()
    assert flow.order() == original_order and flow.effect_count() == original_effect_count
    assert flow.create_session.call_count == 1
    assert all(
        original.data[:100] not in ciphertext for ciphertext, _ in service.objects.objects.values()
    )
    owner = SimpleNamespace(user_id="recipient", require_current=AsyncMock())
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[_owner] = lambda: owner
    app.dependency_overrides[_content_owner] = lambda: owner
    monkeypatch.setattr(routes, "_service", lambda: service)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://one.invalid"
    ) as client:
        url = f"/api/connectors/google_drive/sharing/requests/{flow.request_id}/one-copy/files/{file['fileRef']}/content"
        response = await client.get(url)
        assert response.status_code == 200 and response.content == original.data
        assert response.headers["content-disposition"].startswith("attachment;")
        assert response.headers["content-type"] == "application/octet-stream"
        assert response.headers["x-content-type-options"] == "nosniff"
        assert (await client.get(url + "?disposition=preview")).status_code == 415
        owner.user_id = "unrelated"
        assert (await client.get(url)).status_code == 404
        activity_url = url.rsplit("/files/", 1)[0] + "/activity"
        owner.user_id = "recipient"
        assert (await client.get(activity_url)).status_code == 403
        owner.user_id = "owner"
        first = (await client.get(activity_url + "?limit=1")).json()
        assert first["items"][0]["kind"] == "stream_completed"
        assert first["items"][0]["actorRole"] == "recipient"
        assert first["items"][0]["country"] is None
        second = (
            await client.get(activity_url, params={"limit": 1, "cursor": first["nextCursor"]})
        ).json()
        assert second["items"][0]["kind"] == "download_requested"
        assert first["items"][0]["eventId"] != second["items"][0]["eventId"]
        assert (
            await client.get(activity_url, params={"cursor": first["nextCursor"] + "tampered"})
        ).status_code == 422
        assert (await client.post(url.rsplit("/files/", 1)[0] + "/revoke")).status_code == 200
        history = (await client.get(activity_url)).json()
        assert history["items"][0]["kind"] == "revoked" and history["items"][0]["fileRef"] is None
        owner.user_id = "recipient"
        assert (await client.get(url)).status_code == 404
    assert flow.order() == original_order and flow.effect_count() == original_effect_count


async def withdraw_boundary(flow, service, original, boundary, monkeypatch):
    if boundary == "owner_generation_changed":
        with flow.db.engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE user_external_connector_connections SET connection_generation=2 WHERE user_id='owner' AND connector_id='google_drive'"
                )
            )
    if boundary == "relationship_unlink_relink":
        from hushh_mcp.services.drive_owner_allowed import end_owner_allows_for_disconnected_pair

        with flow.db.engine.begin() as connection:
            connection.execute(text("UPDATE connections SET status='disconnected'"))
            end_owner_allows_for_disconnected_pair(
                connection, user_a_id="owner", user_b_id="recipient"
            )
            # Reconnect before any worker can observe the disconnected state.
            connection.execute(text("UPDATE connections SET status='active'"))
        with pytest.raises(DriveSharingError, match="request_already_decided"):
            await flow.sharing.allow_request(
                user_id="owner",
                request_id=flow.request_id,
                revision=0,
                amount_cents=1000,
                one_copy_accepted=True,
            )
    if boundary == "explicit_access_expiry":
        with flow.db.engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE drive_share_requests SET v1_live_request=TRUE,requested_access_days=1,approved_access_days=1,access_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE request_id=:request"
                ),
                {"request": flow.request_id},
            )
    if boundary == "placement_moves_private":
        from fastapi import HTTPException

        from hushh_mcp.services.document_delivery import background_store

        read = original.chunk

        async def placement_moved(*args):
            result = await read(*args)

            async def private(*args):
                raise HTTPException(
                    status_code=409, detail={"code": "AGENT_PRIVATE_RUNTIME_REQUIRED"}
                )

            monkeypatch.setattr(background_store, "admit_hub_content", private)
            return result

        original.chunk = placement_moved
    if boundary == "changed_content":
        original.facts_value["md5Checksum"] = "0" * 32
    if boundary == "revoke_during_upload":
        send = service.objects.send

        async def revoked_send(*args):
            generation = await send(*args)
            await background_access.revoke(service, request_id=flow.request_id, actor="owner")
            return generation

        service.objects.send = revoked_send


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "boundary",
    [
        "no_copy_consent",
        "unpaid",
        "changed_content",
        "revoke_during_upload",
        "stop_during_read",
        "owner_generation_changed",
        "relationship_unlink_relink",
        "explicit_access_expiry",
        "placement_moves_private",
    ],
)
async def test_no_authority_or_changed_source_never_publishes(flow, copies, boundary, monkeypatch):
    service, original = copies
    await sale(flow, accept=boundary != "no_copy_consent", paid=boundary != "unpaid")
    await withdraw_boundary(flow, service, original, boundary, monkeypatch)
    await service.run()
    projection = await background_access.status(
        service, request_id=flow.request_id, actor="recipient"
    )
    if boundary == "stop_during_read":
        file = projection["files"][0]
        row, _, _ = await background_access.content(
            service,
            request_id=flow.request_id,
            file_ref=file["fileRef"],
            actor="recipient",
            disposition="download",
        )
        stream = service.stream(row=row, actor="recipient")
        assert await anext(stream)
        with flow.db.engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE drive_share_requests SET access_stop_requested_at=clock_timestamp() WHERE request_id=:request"
                ),
                {"request": flow.request_id},
            )
        with pytest.raises(DeliveryError, match="one_copy_revoked"):
            await anext(stream)
        await stream.aclose()
    else:
        assert projection["status"] != "ready"
        if boundary in {"no_copy_consent", "unpaid"}:
            assert original.reads == 0 and projection["files"] == []
        else:
            with flow.db.engine.connect() as connection:
                assert (
                    connection.execute(
                        text(
                            "SELECT count(*) FROM document_delivery_background_files WHERE state='ready'"
                        )
                    ).scalar()
                    == 0
                )
    # Copy failures never cancel or create a different financial/grant operation.
    assert flow.create_session.call_count == (0 if boundary == "no_copy_consent" else 1)
    assert flow.effect_count() == (0 if boundary in {"unpaid", "no_copy_consent"} else 1)


def test_explicit_disclosures_and_source_identity_not_global_file_version():
    with pytest.raises(DriveSharingError):
        request_terms(True, False, ACTIVITY)
    assert request_terms(False, False, None) == {}
    facts = {
        "id": "file",
        "title": "code.js",
        "mimeType": "application/javascript",
        "size": "5",
        "modifiedTime": "2026-10-27T00:00:00Z",
        "md5Checksum": "a" * 32,
        "version": "9",
        "capabilities": {"canDownload": True},
    }
    source = {
        "id": "file",
        "name": "code.js",
        "mimeType": "application/javascript",
        "sourceVersion": "1",
        "sourceContentIdentity": content_identity(facts),
    }
    assert require_original(source, facts) == source["sourceContentIdentity"]
    with pytest.raises(DeliveryError, match="download_restricted"):
        require_original(source, dict(facts, capabilities={"canDownload": False}))
    with pytest.raises(DeliveryError, match="source_identity_unavailable"):
        require_original({**source, "sourceContentIdentity": None}, facts)


@pytest.mark.asyncio
async def test_final_verification_budget_is_bounded_without_repeating_original_reads(flow, copies):
    service, original = copies
    await sale(flow)
    service.objects.read = AsyncMock(side_effect=TimeoutError())
    for _ in range(3):
        await service.run()
    source_reads = original.reads
    assert source_reads == (len(original.data) + CHUNK_BYTES - 1) // CHUNK_BYTES
    projection = await background_access.status(
        service, request_id=flow.request_id, actor="recipient"
    )
    assert projection["status"] == "unavailable"
    assert projection["files"][0]["reason"] == "verification_budget_exhausted"
    await service.run()
    assert original.reads == source_reads


@pytest.mark.asyncio
async def test_uncertain_upload_never_posts_the_same_chunk_again(flow, copies):
    service, original = copies
    await sale(flow)
    send = service.objects.send

    async def uncertain(*args):
        await send(*args)
        raise TimeoutError()

    service.objects.send = AsyncMock(side_effect=uncertain)
    await service.run()
    await service.run()
    assert service.objects.send.await_count == 1
    projection = await background_access.status(
        service, request_id=flow.request_id, actor="recipient"
    )
    assert projection["files"][0]["reason"] == "upload_outcome_unknown"
    with flow.db.engine.connect() as connection:
        custody = (
            connection.execute(text("SELECT * FROM document_delivery_cleanup")).mappings().one()
        )
        assert custody["write_dispatched_at"] is not None and custody["write_settled_at"] is None
        assert custody["upload_session_envelope"] is not None and custody["status"] == "pending"


@pytest.mark.asyncio
async def test_copy_access_ignores_receipt_ttl_but_honors_explicit_grant_deadline(flow, copies):
    service, _ = copies
    await sale(flow)
    await service.run()
    with flow.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_share_requests SET created_at=clock_timestamp()-INTERVAL '2 days',expires_at=clock_timestamp()-INTERVAL '1 day' WHERE request_id=:request"
            ),
            {"request": flow.request_id},
        )
        connection.execute(
            text(
                "UPDATE drive_bulk_shares SET created_at=clock_timestamp()-INTERVAL '2 days',expires_at=clock_timestamp()-INTERVAL '1 day' WHERE origin_request_id=:request"
            ),
            {"request": flow.request_id},
        )
        assert (
            connection.execute(
                text("SELECT held_by_background FROM document_delivery_cleanup LIMIT 1")
            ).scalar()
            is True
        )
    with flow.db.engine.connect() as connection:
        assert connection.execute(text("SELECT TIMESTAMPTZ 'infinity'")).scalar().year == 9999
        assert (
            connection.execute(
                text(
                    "SELECT count(*) FROM document_delivery_cleanup WHERE next_attempt_at<=clock_timestamp()"
                )
            ).scalar()
            == 0
        )
    assert (await background_access.status(service, request_id=flow.request_id, actor="recipient"))[
        "status"
    ] == "ready"
    with flow.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_share_requests SET v1_live_request=TRUE,requested_access_days=1,approved_access_days=1,access_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE request_id=:request"
            ),
            {"request": flow.request_id},
        )
    assert (await background_access.status(service, request_id=flow.request_id, actor="recipient"))[
        "status"
    ] == "revoked"
