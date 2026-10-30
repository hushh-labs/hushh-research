"""Approved labelled Workspace exports reuse the same real SQL sale fixture."""

# ruff: noqa: F401, F811 -- canonical isolated PostgreSQL fixtures

import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.document_delivery import background_access
from hushh_mcp.services.document_delivery.background_exports import FORMATS
from hushh_mcp.services.document_delivery.background_source import CHUNK_BYTES
from hushh_mcp.services.document_delivery.contracts import DeliveryError
from tests.services.test_document_delivery_background import (
    connector_postgres_url,
    copies,
    documents,
    drive,
    drive_connect,
    flow,
    lifecycle,
    request_bulk,
    sale,
    sharing,
)

pytestmark = pytest.mark.feature_protected_documents


@pytest.mark.asyncio
@pytest.mark.parametrize("native_mime", list(FORMATS))
async def test_labelled_export_uses_current_stable_revision_without_second_sale(
    flow, copies, native_mime
):
    service, original = copies
    original.mime_type = native_mime
    exported = b"synthetic complete Google export bytes"
    original.export = AsyncMock(side_effect=lambda *args: bytearray(exported))
    await sale(flow)
    order, effects = flow.order(), flow.effect_count()
    await service.run()
    projection = await background_access.status(
        service, request_id=flow.request_id, actor="recipient"
    )
    file = projection["files"][0]
    fmt, mime, suffix = FORMATS[native_mime]
    assert file["status"] == "ready" and file["rendition"] == "google_export"
    assert file["exportFormat"] == fmt and file["mimeType"] == mime
    assert file["name"] == file["sourceName"] + suffix and file["exportedAt"]
    if fmt == "PDF":
        _, preview_source, _ = await background_access.content(
            service,
            request_id=flow.request_id,
            file_ref=file["fileRef"],
            actor="recipient",
            disposition="preview",
        )
        assert preview_source["mimeType"] == "application/pdf"
        assert preview_source["name"] == file["name"]
    row, _, result = await background_access.content(
        service,
        request_id=flow.request_id,
        file_ref=file["fileRef"],
        actor="recipient",
        disposition="download",
    )
    assert (
        b"".join([chunk async for chunk in service.stream(row=row, actor="recipient")]) == exported
    )
    assert (
        result["sourceRevision"] == "999"
    )  # ACL/global version differs from frozen discovery version 1.
    assert original.reads == 0 and flow.order() == order and flow.effect_count() == effects
    assert flow.create_session.call_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["changed_during_export", "provider_export_limit"])
async def test_changed_or_limited_export_is_unavailable_without_affecting_drive(
    flow, copies, failure
):
    service, original = copies
    original.mime_type = "application/vnd.google-apps.document"
    original.export = AsyncMock(side_effect=lambda *args: bytearray(b"export"))
    if failure == "changed_during_export":
        facts = original.facts
        count = 0

        async def changed(*args):
            nonlocal count
            result = await facts(*args)
            count += 1
            return dict(result, version=str(999 + count))

        original.facts = changed
    else:
        original.export = AsyncMock(side_effect=DeliveryError("export_size_limit"))
    await sale(flow)
    await service.run()
    projection = await background_access.status(
        service, request_id=flow.request_id, actor="recipient"
    )
    if failure == "changed_during_export":
        assert projection["status"] == "ready"
        assert projection["files"][0]["status"] == "ready"
    else:
        assert projection["status"] == "unavailable"
        assert projection["files"][0]["reason"] == "export_size_limit"
    assert flow.order()["status"] == "paid" and flow.effect_count() == 1


@pytest.mark.asyncio
async def test_new_trusted_combined_request_needs_one_allow_old_drive_request_stays_auto(
    flow, copies, monkeypatch
):
    service, _ = copies
    created = await flow.request(trusted=True, allow=False)
    assert flow.private().get("trusted_auto") is not True
    assert await flow.sharing.due_trusted_searches(limit=20) == []
    await flow.sharing.allow_request(
        user_id="owner",
        request_id=flow.request_id,
        revision=created["revision"],
        amount_cents=1000,
        one_copy_accepted=True,
    )
    with flow.db.engine.connect() as connection:
        assert (
            connection.execute(
                text(
                    "SELECT count(*) FROM document_delivery_background_requests WHERE request_id=:request"
                ),
                {"request": flow.request_id},
            ).scalar()
            == 1
        )
    assert flow.private()["trusted_auto"] is True
    # The historic default/Drive-only call still gets the original Trusted behavior.

    async def legacy(**kwargs):
        from hushh_mcp.services.drive_sharing_store import DriveSharingStore

        return await DriveSharingStore.create_request(flow.sharing, **kwargs)

    monkeypatch.setattr(flow.sharing, "create_request", legacy)
    await flow.request(trusted=True, allow=False)
    assert flow.private()["trusted_auto"] is True and "one_copy" not in flow.private()


@pytest.mark.asyncio
async def test_source_owner_placement_flip_after_object_read_emits_no_plaintext(
    flow, copies, monkeypatch
):
    from fastapi import HTTPException

    service, _ = copies
    await sale(flow)
    await service.run()
    projection = await background_access.status(
        service, request_id=flow.request_id, actor="recipient"
    )
    row, _, _ = await background_access.content(
        service,
        request_id=flow.request_id,
        file_ref=projection["files"][0]["fileRef"],
        actor="recipient",
        disposition="download",
    )
    read = service.objects.read

    async def moved(*args, **kwargs):
        result = await read(*args, **kwargs)
        monkeypatch.setattr(
            "hushh_mcp.services.owner_placement_guard.get_owner_hosting_mode",
            AsyncMock(return_value="byoc"),
        )
        return result

    service.objects.read = moved
    stream = service.stream(row=row, actor="recipient")
    with pytest.raises(HTTPException) as failure:
        await anext(stream)
    assert failure.value.status_code == 409
    await stream.aclose()


@pytest.mark.asyncio
async def test_canonical_account_erasure_preserves_exact_ciphertext_cleanup_custody(flow, copies):
    from hushh_mcp.services.drive_sharing_retention import erase_drive_account_in_transaction

    service, _ = copies
    await sale(flow)
    await service.run()
    assert service.objects.objects
    with flow.db.engine.begin() as connection:
        erase_drive_account_in_transaction(connection, user_id="recipient", permanent=False)
        assert (
            connection.execute(
                text("SELECT count(*) FROM document_delivery_background_files")
            ).scalar()
            == 0
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM document_delivery_background_chunks")
            ).scalar()
            == 0
        )
        rows = connection.execute(text("SELECT * FROM document_delivery_cleanup")).mappings().all()
        assert len(rows) == len(service.objects.objects)
        assert all(
            row["status"] == "pending"
            and not row["held_by_background"]
            and row["object_generation"] is not None
            for row in rows
        )
        assert all(row["object_key"] in service.objects.objects for row in rows)


@pytest.mark.asyncio
async def test_stale_producer_cannot_retire_successor_ready_objects(flow, copies):
    service, _ = copies
    await sale(flow)
    await service.store.enroll(1)
    stale = await service.store.claim()
    with flow.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE document_delivery_background_files
              SET lease_expires_at=clock_timestamp()-INTERVAL '1 second',
                  next_at=clock_timestamp() WHERE file_ref=:ref"""),
            {"ref": stale["file_ref"]},
        )
    successor = await service.store.claim()
    assert successor["lease_id"] != stale["lease_id"]
    assert await service.produce(successor, time.monotonic() + 30) == "released"
    await service.stop(stale, "copy_unavailable")
    await service.defer(stale)
    with flow.db.engine.connect() as connection:
        current = (
            connection.execute(
                text("SELECT * FROM document_delivery_background_files WHERE file_ref=:ref"),
                {"ref": stale["file_ref"]},
            )
            .mappings()
            .one()
        )
        assert current["state"] == "ready" and current["reason"] is None
        cleanup = (
            connection.execute(text("SELECT * FROM document_delivery_cleanup")).mappings().all()
        )
        assert cleanup and all(row["held_by_background"] for row in cleanup)
        assert all(row["next_attempt_at"].year == 9999 for row in cleanup)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "ended", ["generation", "bulk_stop", "invalidated", "payment", "refund", "waived"]
)
async def test_invalid_old_candidate_cannot_starve_later_valid_copy(flow, copies, ended):
    service, _ = copies
    await sale(flow)
    old_request = flow.request_id
    await sale(flow)
    valid_request = flow.request_id
    with flow.db.engine.begin() as connection:
        statements = {
            "generation": "UPDATE document_delivery_background_requests SET connection_generation=0 WHERE request_id=:request",
            "bulk_stop": "UPDATE drive_bulk_shares SET stopped_at=clock_timestamp() WHERE origin_request_id=:request",
            "invalidated": "UPDATE drive_share_requests SET approval_invalidated_at=clock_timestamp() WHERE request_id=:request",
            "payment": "UPDATE drive_request_payment_orders SET reconciliation_required=TRUE,reconciliation_reason='authority_changed',reconciliation_at=clock_timestamp() WHERE request_id=:request",
            "refund": "INSERT INTO drive_request_payment_refunds(request_id,attempt_id,status) VALUES(:request,:attempt,'queued')",
            "waived": "UPDATE document_delivery_background_requests SET connection_generation=0 WHERE request_id=:request",
        }
        connection.execute(
            text(statements[ended]), {"request": old_request, "attempt": str(uuid4())}
        )
        if ended == "waived":
            connection.execute(
                text(
                    "UPDATE drive_share_requests SET payment_required=FALSE,existing_access_waived_at=clock_timestamp() WHERE request_id=:request"
                ),
                {"request": valid_request},
            )
            connection.execute(text(statements["payment"]), {"request": valid_request})
    await service.store.enroll(1)
    with flow.db.engine.connect() as connection:
        enrolled = (
            connection.execute(text("SELECT request_id FROM document_delivery_background_files"))
            .scalars()
            .all()
        )
        assert list(map(str, enrolled)) == [valid_request]


def production_objects():
    """Real object adapters; only HTTP response bytes and GCS storage are fake."""
    from hushh_mcp.services.document_delivery.contracts import digest
    from hushh_mcp.services.document_delivery.storage import PrivateGcsCipherObjects
    from hushh_mcp.services.shared_files.bucket_admission import admission
    from hushh_mcp.services.shared_files.uploads import SharedCipherStore

    bucket = {
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
    transport = SharedCipherStore(
        bucket["name"], prefix="document-delivery/v1", session=SimpleNamespace()
    )
    values, sessions = {}, {}
    transport._object_get = lambda *args: SimpleNamespace(status_code=200, json=lambda: bucket)

    def request(method, url, **kwargs):
        response = SimpleNamespace(status_code=200, close=lambda: None, headers={})
        if method == "post":
            uri = f"https://storage.googleapis.com/upload/storage/v1/b/{bucket['name']}/o?uploadType=resumable&upload_id={len(sessions)}"
            sessions[uri] = kwargs["params"]["name"]
            response.headers["location"] = uri
        else:
            assert method == "put"
            name = sessions[url]
            data = bytes(kwargs["data"])
            values[name] = (data, str(len(values) + 1))
            body = json.dumps(
                {"name": name, "size": len(data), "generation": values[name][1]}
            ).encode()
            response.iter_content = lambda chunk_size: [body]
        return response

    transport._request = request

    async def read(path, max_bytes):
        value, generation = values[transport._key(path)]
        assert len(value) <= max_bytes
        return value, generation

    transport.get_bounded_with_generation = read
    return PrivateGcsCipherObjects(
        bucket=bucket["name"],
        identity=digest(admission(bucket, bucket["name"])["identity"]),
        store=transport,
    ), values


@pytest.mark.asyncio
@pytest.mark.parametrize("size", [1, 11, CHUNK_BYTES + 1, CHUNK_BYTES + 11])
async def test_tiny_original_and_short_tail_use_production_ciphertext_frame(flow, copies, size):
    from hushh_mcp.services.document_delivery import background_objects

    service, original = copies
    original.data = b"x" * size
    service._objects, values = production_objects()
    await sale(flow)
    assert (await service.run())["outcomes"] == {"released": 1}
    projection = await background_access.status(
        service, request_id=flow.request_id, actor="recipient"
    )
    row, _, result = await background_access.content(
        service,
        request_id=flow.request_id,
        file_ref=projection["files"][0]["fileRef"],
        actor="recipient",
        disposition="download",
    )
    assert (
        b"".join([part async for part in service.stream(row=row, actor="recipient")])
        == original.data
    )
    assert result["bytes"] == size and all(len(value[0]) >= 28 for value in values.values())
    chunks = await service.store.chunks(row)
    chunk = chunks[-1]
    frame, _ = values[service.objects.store._key(chunk["object_key"])]
    assert chunk["descriptor"]["ciphertextBytes"] == len(frame)
    altered = {**chunk, "descriptor": {**chunk["descriptor"], "iv": "00" * 12}}
    with pytest.raises(DeliveryError, match="copy_integrity_mismatch"):
        background_objects.decrypt(service.store, row, altered, frame)


@pytest.mark.asyncio
async def test_copy_pause_uses_lease_deferral_without_failure_or_payment_replay(
    flow, copies, monkeypatch
):
    service, original = copies
    await sale(flow)
    order, effects = flow.order(), flow.effect_count()
    monkeypatch.setattr(service.store, "production_paused", lambda row: True)
    result = await service.run(max_jobs=1)
    assert result["outcomes"]["deferred"] == 1
    assert original.reads == 0
    with flow.db.engine.begin() as connection:
        row = (
            connection.execute(
                text(
                    "SELECT state,failures,lease_id FROM document_delivery_background_files WHERE request_id=:request"
                ),
                {"request": flow.request_id},
            )
            .mappings()
            .one()
        )
        assert row["state"] == "preparing" and row["failures"] == 0 and row["lease_id"] is None
        connection.execute(
            text(
                "UPDATE document_delivery_background_files SET next_at=clock_timestamp() WHERE request_id=:request"
            ),
            {"request": flow.request_id},
        )
    monkeypatch.setattr(service.store, "production_paused", lambda row: False)
    await service.run(max_jobs=1)
    assert (await background_access.status(service, request_id=flow.request_id, actor="recipient"))[
        "files"
    ][0]["status"] == "ready"
    assert flow.order() == order and flow.effect_count() == effects
