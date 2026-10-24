"""Hermetic HTTP -> financial preset -> Drive REST -> PostgreSQL -> owner loop."""

# ruff: noqa: F401,F811 -- reuse disposable PostgreSQL fixture dependencies
from __future__ import annotations

import asyncio
import json
import re
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI, Header, HTTPException
from sqlalchemy import text

from api.middleware import require_vault_owner_token
from api.middlewares.observability import get_request_trace_metadata, observability_middleware
from api.routes import drive_packet_previews
from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_telemetry import correlation_tag
from hushh_mcp.services.google_drive_adapter import DriveReadError, GoogleDriveAdapter
from hushh_mcp.services.google_drive_rest_transport import GoogleDriveRestTransport
from tests.services.test_drive_period_packet_previews_postgres import (
    collection,
    collection_pages,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    ingestion,
    lifecycle,
    preview_runtime,
    reusable,
    sharing,
)

pytestmark = [pytest.mark.feature_drive_packets, pytest.mark.trace_loop]


def messy_pages(head):
    """Two raw Drive pages: duplicate identity/names, MIME variants and missing parents."""
    stamp = f"{head['period_start']}T12:00:00Z"
    files = [
        {
            "id": f"loop-file-{i}",
            "name": "Private loop statement.pdf",
            "mimeType": (
                "video/mp4"
                if i == 0
                else "application/vnd.google-apps.document"
                if i == 1
                else "application/pdf"
            ),
            "version": "1",
            "createdTime": stamp,
            "modifiedTime": stamp,
            "parents": ["missing-parent" if i == 2 else "nested-folder"],
            "trashed": False,
            "capabilities": {"canShare": i != 0},
        }
        for i in range(137)
    ]
    # Without a creation time, a generic filename falls back to modified time.
    files[2].pop("createdTime")
    return [
        files[:75],
        files[75:]
        + [
            files[1],
            {
                **files[2],
                "id": "outside-window",
                "createdTime": "1999-01-01T00:00:00Z",
                "modifiedTime": "1999-01-01T00:00:00Z",
            },
            {**files[3], "id": "deleted-file", "trashed": True},
            {**files[4], "id": "nested-folder", "mimeType": "application/vnd.google-apps.folder"},
        ],
    ]


def fake_drive(pages, calls, failure):
    def handle(request):
        assert request.method == "GET"  # No content read, folder creation, grant or payment.
        assert request.url.path in {"/drive/v3/files", "/drive/v3/drives"}
        if request.url.path.endswith("/drives"):
            payload = {"drives": []}
        else:
            query = request.url.params["q"]
            assert "trashed = false" in query and "application/vnd.google-apps.folder" in query
            # This preset uses title_created_modified, with host date validation.
            assert "name contains 'statement'" in query
            assert "fullText contains" in query and "invoice" in query and " or " in query
            page = request.url.params.get("pageToken")
            calls.append(page)
            if failure and len(calls) == 1:
                if failure == "timeout":
                    raise httpx.ReadTimeout("synthetic timeout", request=request)
                return httpx.Response(429, stream=httpx.ByteStream(b"{}"))
            raw = pages[1 if page else 0]
            payload = {
                "files": [
                    f
                    for f in raw
                    if not f["trashed"] and f["mimeType"] != "application/vnd.google-apps.folder"
                ],
                "nextPageToken": None if page else "page-two",
                "incompleteSearch": False,
            }
        return httpx.Response(200, stream=httpx.ByteStream(json.dumps(payload).encode()))

    return httpx.MockTransport(handle)


def loop_app(service, monkeypatch):
    async def verified(authorization: str = Header(), hushh_consent=None):
        user = {"Bearer synthetic-owner": "owner", "Bearer synthetic-other": "other"}.get(
            authorization
        )
        if not user:
            raise HTTPException(401)
        return {"user_id": user, "token": authorization.removeprefix("Bearer ")}

    monkeypatch.setattr("api.routes.drive_sharing_owner.require_vault_owner_token", verified)
    monkeypatch.setattr(drive_packet_previews, "_period_packet_service", lambda: service)
    app = FastAPI()
    app.middleware("http")(observability_middleware)
    app.dependency_overrides[require_vault_owner_token] = verified
    app.include_router(drive_packet_previews.router)
    return app


async def resume(client, service, path, headers):
    for _ in range(5):
        response = await client.post(path, json={}, headers=headers)
        assert response.status_code == 200
        if response.json()["complete"]:
            return response
        # Advance only synthetic retry time; keep the real lease/checkpoint contract.
        with service.store.db.engine.begin() as connection:
            connection.execute(text("UPDATE drive_packet_heads SET next_at=clock_timestamp()"))
            connection.execute(text("UPDATE drive_owner_search_jobs SET next_at=clock_timestamp()"))
    pytest.fail("Own-account discovery did not finish")


def assert_trace(caplog, request_id, *, retries):
    messages = [
        r.getMessage()
        for r in caplog.records
        if r.name.startswith("drive_") or r.name.startswith("hushh_mcp.services.google_drive")
    ]
    tags = [m for m in messages if f"request_tag={correlation_tag(request_id)}" in m]
    stages = [
        re.search(r"stage=(\w+).*outcome=(\w+).*duration_ms=([\d.]+)", m)
        for m in tags
        if "drive_stage.timing" in m
    ]
    stages = [m.groups() for m in stages if m]
    names = [s[0] for s in stages]
    assert (
        names.index("packet_query") < names.index("packet_snapshot") < names.index("search_claim")
    )
    assert names.index("search_claim") < names.index("provider") < names.index("search_commit")
    assert "packet_plan" not in names and "packet_tagging" not in names
    assert names[-1] == "packet_snapshot"
    assert sum(status == "error" for _, status, _ in stages) == retries
    assert all(float(duration) < 45000 for _, _, duration in stages)
    assert any("period_packet.search outcome=completed matched=137" in m for m in tags)
    assert all(
        "Private loop" not in m and "loop-file-" not in m and "synthetic-owner" not in m
        for m in messages
    )
    assert get_request_trace_metadata() is None


def assert_persisted(service, matched):
    with service.store.db.engine.connect() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM drive_owner_search_results")).scalar_one()
            == matched
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders")
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_effects")).scalar_one()
            == 0
        )


@pytest.mark.parametrize(
    "enabled,failure", [(False, None), (True, None), (True, "429"), (True, "timeout")]
)
async def test_http_drive_packet_trace_loop(
    reusable, lifecycle, monkeypatch, caplog, enabled, failure
):
    started = time.monotonic()
    service, head, planner, _ = await preview_runtime(reusable, monkeypatch)
    planner.side_effect = AssertionError("financial preset must not call Azure")
    tagging = AsyncMock(side_effect=AssertionError("tagging blocked discovery"))
    monkeypatch.setattr(
        "hushh_mcp.services.drive_financial_packet_tagging.FinancialPacketTagger.run_one", tagging
    )
    pages, calls = messy_pages(head), []
    adapter = GoogleDriveAdapter()

    async def credential(**kwargs):
        return await lifecycle.read(user_id=kwargs["user_id"], connector_id="google_drive"), {
            "accessToken": "synthetic"
        }

    oauth = SimpleNamespace(current_credential=credential, lifecycle=lifecycle)
    service.search = DriveOwnerSearchService(
        store=service.search.store, transport=GoogleDriveRestTransport(oauth=oauth, adapter=adapter)
    )
    app = loop_app(service, monkeypatch)
    for logger in (
        "drive_period_packets",
        "drive_owner_search",
        "hushh_mcp.services.google_drive_rest_transport",
    ):
        caplog.set_level("INFO", logger=logger)
    monkeypatch.setenv("DRIVE_PERIOD_PACKETS_ENABLED", str(enabled).lower())
    monkeypatch.setenv("DRIVE_AGENT_PACKAGES_ENABLED", "false")
    monkeypatch.setenv("DRIVE_FOUR_GROUP_INDEX_ENABLED", "false")
    request_id = str(uuid4())
    headers = {
        "Authorization": "Bearer synthetic-owner",
        "X-Request-Id": request_id,
        "X-Trace-Id": request_id,
        "X-Feature-Flags": "drive_period_packets=true",
    }
    path = f"/api/connectors/google_drive/sharing/packets/{head['packet_id']}/preview"
    async with httpx.AsyncClient(transport=fake_drive(pages, calls, failure)) as provider:
        marker = adapter._read_client.set(provider)
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                if not enabled:
                    response = await client.post(path, json={}, headers=headers)
                    assert response.status_code == 503 and not calls and not planner.called
                    assert_persisted(service, 0)
                    return  # Untrusted request headers cannot enable the server-disabled feature.
                response = await resume(client, service, path, headers)
                assert response.headers["x-trace-id"] == request_id
                result = response.json()
                assert result["status"] == "completed" and result["matched"] == 137
                all_files, cursor = result["documents"], result["nextCursor"]
                while cursor:
                    rest = await client.get(path, params={"cursor": cursor}, headers=headers)
                    assert rest.status_code == 200
                    page = rest.json()
                    all_files += page["documents"]
                    cursor = page["nextCursor"]
                assert len(all_files) == len({f["viewUrl"] for f in all_files}) == 137
                assert not any("packetTag" in file for file in all_files)
                planner.assert_not_awaited()
                tagging.assert_not_awaited()
                with service.store.db.engine.connect() as connection:
                    row = dict(
                        connection.execute(
                            text("""SELECT * FROM drive_packet_heads
                      WHERE packet_id=:id"""),
                            {"id": head["packet_id"]},
                        )
                        .mappings()
                        .one()
                    )
                    assert row["tagging_pending"] and row["current_version"] == 0
                    build = service.store._build(row)
                    search = dict(
                        connection.execute(
                            text("""SELECT * FROM drive_owner_search_jobs
                      WHERE user_id='owner' AND job_id=:id"""),
                            {"id": build["search_job_id"]},
                        )
                        .mappings()
                        .one()
                    )
                    checkpoint = service.search.store._checkpoint(search)
                    assert search["status"] == "completed" and search["matched"] == 137
                    assert checkpoint["query_source"]["kind"] == "predefined"
                    assert checkpoint["query_source"]["planner_executed"] is False
                    assert checkpoint["semantic_model_binding"] is None
                    assert checkpoint["semantic_plan"]["date_basis"] == "title_created_modified"
                    assert build["query_source"] == checkpoint["query_source"]
                # The packet owns its saved originals beyond temporary search TTL.
                with service.store.db.engine.begin() as connection:
                    connection.execute(
                        text("""UPDATE drive_owner_search_jobs
                      SET expires_at=clock_timestamp()-INTERVAL '1 second'
                      WHERE job_id=:id"""),
                        {"id": build["search_job_id"]},
                    )
                await service.search.store.purge()
                retained = await client.get(path, headers=headers)
                assert retained.status_code == 200 and retained.json()["matched"] == 137
                assert retained.json()["nextCursor"] and not retained.json()["limited"]
                assert sum(not f["shareable"] for f in all_files) == 1
                assert calls == ([None, None, "page-two"] if failure else [None, "page-two"])
                count = len(calls)
                assert (await client.get(path, headers=headers)).status_code == 200
                denied = await client.get(path, headers={"Authorization": "Bearer synthetic-other"})
                assert denied.status_code != 200 and len(calls) == count
                with service.store.db.engine.begin() as connection:
                    connection.execute(
                        text("""UPDATE user_external_connector_connections
                      SET status='revoked' WHERE user_id='owner' AND connector_id='google_drive'""")
                    )
                revoked = await client.get(path, headers=headers)
                assert revoked.status_code != 200 and len(calls) == count
        finally:
            adapter._read_client.reset(marker)
    assert_persisted(service, 137)
    assert_trace(caplog, request_id, retries=1 if failure else 0)
    assert time.monotonic() - started < 45


@pytest.mark.parametrize("fence", [None, "revoked", "background", "revision", "lease"])
async def test_saved_financial_tags_preserve_originals_and_require_current_authority(
    reusable, monkeypatch, fence
):
    from hushh_mcp.services import drive_financial_packet_tag_store as tags

    service, head, planner, transport = await preview_runtime(reusable, monkeypatch)
    identity = str(head["packet_id"])
    for _ in range(5):
        result = await service.prepare_preview(user_id="owner", packet_id=identity)
        if result["complete"]:
            break
    assert result["complete"] and result["matched"] == 26
    planner.assert_not_awaited()
    reads = transport.read_tool.await_count
    job = await tags.claim(service.store, "synthetic-local-organizer-v1")
    assert job and len(job["items"]) == tags.BATCH and job["user_id"] == "owner"
    await tags.require_current(service.store, job)
    with service.store.db.engine.connect() as connection:
        before = list(
            connection.execute(
                text("""SELECT position,metadata_envelope
          FROM drive_owner_search_results WHERE job_id=:job ORDER BY position"""),
                {"job": job["search_id"]},
            ).mappings()
        )
    labels = [
        {
            "bucket": "review",
            "reason": "no_evidence",
            "group": None,
            "policyVersion": tags.POLICY,
            "sourceVersion": item["source"]["sourceVersion"],
        }
        for item in job["items"]
    ]
    if fence:
        if fence == "background":
            await service.store.set_background(user_id="owner", enabled=False, confirmed=True)
        else:
            statement = {
                "revoked": "UPDATE user_external_connector_connections SET status='revoked' WHERE user_id='owner' AND connector_id='google_drive'",
                "revision": "UPDATE drive_packet_heads SET revision=revision+1,build_envelope=NULL WHERE packet_id=:id",
                "lease": "UPDATE drive_packet_heads SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE packet_id=:id",
            }[fence]
            with service.store.db.engine.begin() as connection:
                connection.execute(text(statement), {"id": identity})
        with pytest.raises(DriveReadError):
            await tags.commit(service.store, job, labels)
    else:
        await tags.commit(service.store, job, labels)
        after = await service.preview(user_id="owner", packet_id=identity)
        assert after["complete"] and after["matched"] == 26
        assert len(after["documents"]) == 25 and after["nextCursor"]
        assert sum("packetTag" in file for file in after["documents"]) == tags.BATCH
        assert after["tagging"]["counts"] == {
            "financial": 0,
            "review": 8,
            "other": 0,
            "pending": 18,
        }
    with service.store.db.engine.connect() as connection:
        after = list(
            connection.execute(
                text("""SELECT position,metadata_envelope
          FROM drive_owner_search_results WHERE job_id=:job ORDER BY position"""),
                {"job": job["search_id"]},
            ).mappings()
        )
        if fence:
            assert after == before
        assert len(after) == 26
    assert transport.read_tool.await_count == reads
    planner.assert_not_awaited()
    assert_persisted(service, 26)


@pytest.mark.parametrize("cached_version", ["1", "2"])
async def test_background_organizer_uses_saved_candidates_and_keeps_every_original(
    reusable, monkeypatch, cached_version
):
    from hushh_mcp.services.drive_financial_packet_tagging import FinancialPacketTagger
    from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
    from tests.drive_postgres_test_support import apply_drive_fixture_migration

    service, head, planner, _ = await preview_runtime(reusable, monkeypatch)
    result = await service.prepare_preview(user_id="owner", packet_id=str(head["packet_id"]))
    assert result["complete"] and result["matched"] == 26
    with service.store.db.engine.begin() as connection:
        apply_drive_fixture_migration(connection, "410_drive_group_index.sql")
        from hushh_mcp.services.drive_group_index_store import DriveGroupCipher

        cipher = DriveGroupCipher()
        ref = cipher.ref("owner", "preview-file-0")
        envelope = cipher.seal_entry(
            {"id": "preview-file-0"}, user_id="owner", ref=ref, generation=1
        )
        connection.execute(
            text("""INSERT INTO drive_group_index(user_id,connection_generation,
            source_ref,shelf,candidate,confidence,reason,group_source,model_version,source_modified,
            source_version,entry_envelope) VALUES('owner',1,:ref,'financial_statements','financial_statements',
            1,'placed','owner','000000000000',:modified,:version,CAST(:envelope AS jsonb))"""),
            {
                "ref": ref,
                "modified": f"{head['period_start']}T12:00:00Z",
                "version": cached_version,
                "envelope": json.dumps(envelope),
            },
        )
    calls = []

    async def read(**kwargs):
        assert kwargs["user_id"] == "owner" and kwargs["expected_generation"] == 1
        calls.append(kwargs["tool_name"])
        if kwargs["tool_name"] == "get_file_metadata":
            return ExternalMcpToolResult(False, {"file": {"version": "1", "trashed": False}}, False)
        assert kwargs["tool_name"] == "read_file_content"
        return ExternalMcpToolResult(
            False,
            {
                "fileContent": "Account statement opening balance closing balance transactions tax invoice"
            },
            False,
        )

    class LocalEmbedding:
        async def embed(self, heads):
            assert all(len(head) <= 400 for head in heads)
            return [None for head in heads]

    worker = FinancialPacketTagger(
        store=service.store,
        transport=SimpleNamespace(read_group_index_tool=read),
        embedder=LocalEmbedding(),
    )
    for _ in range(4):
        outcome = await worker.run_one()
    assert outcome == "completed"
    after = await service.preview(user_id="owner", packet_id=str(head["packet_id"]))
    assert after["complete"] and after["matched"] == 26
    assert sum(after["tagging"]["counts"].values()) == 26
    assert after["tagging"]["counts"]["pending"] == 0
    assert all("packetTag" in document for document in after["documents"])
    assert after["documents"][0]["packetTag"]["bucket"] == (
        "financial" if cached_version == "1" else "review"
    )
    if cached_version == "1":
        assert after["documents"][0]["packetTag"]["groupSource"] == "owner"
    with service.store.db.engine.connect() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM drive_group_index_state")).scalar_one()
            == 0
        )
    assert "read_file_content" in calls and set(calls) == {"get_file_metadata", "read_file_content"}
    planner.assert_not_awaited()
    assert_persisted(service, 26)
