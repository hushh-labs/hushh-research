"""Long provider originals remain usable through packet HTTP and saved projections."""

# ruff: noqa: F401,F811 -- existing disposable PostgreSQL fixture graph
import json

import httpx
import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_period_packet_preview import document, write_build
from hushh_mcp.services.google_drive_adapter import METADATA_LIMIT
from tests.services.test_drive_period_packet_loop_postgres import (
    collection,
    collection_pages,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    fake_drive,
    ingestion,
    lifecycle,
    loop_app,
    messy_pages,
    preview_runtime,
    resume,
    reusable,
    sharing,
    wire_packet_provider,
)

pytestmark = [pytest.mark.feature_drive_packets, pytest.mark.trace_loop]


def assert_labels(payload, expected):
    assert payload["matched"] == expected and payload["complete"]
    assert len(json.dumps(payload)) < 262144
    for item in payload["documents"]:
        assert len(item["name"].encode("utf-16-le")) <= 510
        assert item["name"].endswith("…") and item["viewUrl"].startswith(
            "https://drive.google.com/"
        )


async def assert_originals_and_legacy_cache(service, head, names):
    with service.store.db.engine.begin() as connection:
        row = dict(
            connection.execute(
                text("SELECT * FROM drive_packet_heads WHERE packet_id=:id"),
                {"id": head["packet_id"]},
            )
            .mappings()
            .one()
        )
        build = service.store._build(row)
        search_id = build["search_job_id"]
        originals = connection.execute(
            text(
                "SELECT position,metadata_envelope FROM drive_owner_search_results WHERE job_id=:id ORDER BY position"
            ),
            {"id": search_id},
        ).mappings()
        retained = [
            service.search.store.search_cipher.open(
                item["metadata_envelope"],
                user_id="owner",
                resource_id=f"{search_id}:{item['position']}",
                purpose="owner-search-result",
            )
            for item in originals
        ]
        assert {item["name"] for item in retained} == set(names)
        # An older cached projection may contain raw labels. Reading it must not rewrite originals.
        for item, source in zip(build["preview"]["documents"], retained, strict=True):
            item["name"] = source["name"]
        build.pop("search_job_id")
        write_build(service.store, connection, row, build)
        connection.execute(
            text(
                "UPDATE drive_owner_search_jobs SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE job_id=:id"
            ),
            {"id": search_id},
        )
    cached = await service.preview(user_id="owner", packet_id=str(head["packet_id"]))
    assert_labels(cached, len(names))
    return cached


@pytest.mark.parametrize("historical", [False, True])
async def test_long_title_originals_reach_http_preview_frozen_catalog_and_cache(
    reusable, lifecycle, monkeypatch, historical
):
    service, head, planner, _ = await preview_runtime(reusable, monkeypatch, historical=historical)
    raw = messy_pages(head)[0][:26]
    for index, item in enumerate(raw):
        item["name"] = ("Private long title " + "N" * 1100 if index % 2 else "📄" * 600) + str(
            index
        )
    names, calls = [item["name"] for item in raw], []
    pages = [raw[:13], raw[13:]]
    assert all(len(json.dumps(page).encode()) < METADATA_LIMIT for page in pages)
    adapter = wire_packet_provider(service, lifecycle)
    app = loop_app(service, monkeypatch)
    path = f"/api/connectors/google_drive/sharing/packets/{head['packet_id']}/preview"
    headers = {"Authorization": "Bearer synthetic-owner", "X-Trace-Id": "long-packet-wire"}
    async with httpx.AsyncClient(transport=fake_drive(pages, calls, None)) as provider:
        marker = adapter._read_client.set(provider)
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await resume(client, service, path, headers)
                result = response.json()
                assert_labels(result, 26)
                assert response.headers["x-trace-id"] == "long-packet-wire"
                tail = (
                    await client.get(path, params={"cursor": result["nextCursor"]}, headers=headers)
                ).json()
                all_files = result["documents"] + tail["documents"]
                assert len(all_files) == len({item["viewUrl"] for item in all_files}) == 26
                assert len({item["name"] for item in all_files}) == 2
        finally:
            adapter._read_client.reset(marker)
    assert calls == [None, "page-two"]
    planner.assert_not_awaited()
    await assert_originals_and_legacy_cache(service, head, names)
    if historical:
        catalog = await service.store.list_packets(user_id="owner", owner_contents=True)
        packet = next(
            item for item in catalog["packets"] if item["packetId"] == str(head["packet_id"])
        )
        assert packet["documentCount"] == 26
        assert packet["saleDocumentCount"] == 25
        assert len(packet["contents"]["documents"]) == 25
        assert all(
            len(item["name"].encode("utf-16-le")) <= 510 for item in packet["contents"]["documents"]
        )


def test_extreme_provider_names_cannot_expand_packet_preview_wire_size():
    original = "📄" * (METADATA_LIMIT // 4)
    sources = [{"id": f"synthetic-{i}", "name": original} for i in range(25)]
    payload = {"documents": [document(source) for source in sources]}
    assert len(json.dumps(payload)) < 262144
    assert all(source["name"] == original for source in sources)
    assert all(len(item["name"].encode("utf-16-le")) <= 510 for item in payload["documents"])
