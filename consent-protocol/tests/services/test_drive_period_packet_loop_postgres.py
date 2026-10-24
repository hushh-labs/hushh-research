"""Hermetic HTTP -> Azure-plan port -> Drive REST -> PostgreSQL -> owner loop."""

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
from hushh_mcp.services.google_drive_adapter import GoogleDriveAdapter
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
        for i in range(26)
    ]
    return [
        files[:15],
        files[15:]
        + [
            files[1],
            {**files[2], "id": "outside-window", "createdTime": "1999-01-01T00:00:00Z"},
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
            assert "createdTime >=" in query and "createdTime <" in query
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
    assert names.index("packet_plan") < names.index("packet_snapshot") < names.index("search_claim")
    assert names.index("search_claim") < names.index("provider") < names.index("search_commit")
    assert names[-1] == "packet_snapshot"
    assert sum(status == "error" for _, status, _ in stages) == retries
    assert all(float(duration) < 45000 for _, _, duration in stages)
    assert any("period_packet.search outcome=completed matched=26" in m for m in tags)
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
                assert result["status"] == "completed" and result["matched"] == 26
                all_files = result["documents"]
                rest = await client.get(
                    path, params={"cursor": result["nextCursor"]}, headers=headers
                )
                all_files += rest.json()["documents"]
                assert len(all_files) == len({f["viewUrl"] for f in all_files}) == 26
                assert sum(not f["shareable"] for f in all_files) == 1
                assert calls == ([None, None, "page-two"] if failure else [None, "page-two"])
                count = len(calls)
                assert (await client.get(path, headers=headers)).status_code == 200
                denied = await client.get(path, headers={"Authorization": "Bearer synthetic-other"})
                assert denied.status_code != 200 and len(calls) == count
        finally:
            adapter._read_client.reset(marker)
    assert_persisted(service, 26)
    assert_trace(caplog, request_id, retries=1 if failure else 0)
    assert time.monotonic() - started < 45
