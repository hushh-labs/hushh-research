"""No-provider-I/O checks for index routing and full evidence reuse."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_owner_search_store import validate_reusable_packet
from hushh_mcp.services.drive_request_package_service import indexed_evidence_source
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_reusable_packets_postgres import document_facts


def manifest(count=1):
    return {
        "packet_id": "packet",
        "version": 1,
        "digest": "a" * 64,
        "owner_user_id": "owner",
        "state": "ready",
        "listing_revision": 2,
        "price_cents": 125,
        "sources": [
            {"document_id": f"doc{i}", "source_version": "7", "facts_version": f"facts{i}"}
            for i in range(count)
        ],
        "source_metadata": {
            f"doc{i}": {
                "file_id": f"file{i}",
                "name": f"Statement{i}",
                "mime_type": "application/pdf",
                "version": "7",
            }
            for i in range(count)
        },
    }


def binding():
    return {
        "packetId": "packet",
        "version": 1,
        "manifestDigest": "a" * 64,
        "ownerUserId": "owner",
        "listingRevision": 2,
        "priceCents": 125,
    }


@pytest.mark.parametrize(
    "key,value",
    [
        ("digest", "b" * 64),
        ("listing_revision", 3),
        ("price_cents", 500),
        ("owner_user_id", "other"),
        ("state", "incomplete"),
    ],
)
def test_reusable_binding_does_not_transfer_versions_or_prices(key, value):
    with pytest.raises(DriveReadError, match="packet_unavailable"):
        validate_reusable_packet(manifest() | {key: value}, binding(), "owner")


def test_index_adapter_keeps_late_evidence_beyond_legacy_excerpt():
    facts = document_facts([{"page": 1}])
    facts["facts"] = [
        {
            "value": str(i) + "x" * 480,
            "citations": [{"page": i + 1, "quote": "Synthetic statement evidence"}],
        }
        for i in range(50)
    ]
    facts["facts"][-1]["citations"][0]["quote"] = "The late-page answer after twenty kilobytes"
    source = indexed_evidence_source(
        document_ref="p1",
        document={
            "source_version": "7",
            "facts_version": "v1",
            "metadata": {"name": "Generic.pdf"},
            "facts": facts,
            "complete": True,
        },
    )
    assert len(source["text"].encode()) > 20 * 1024
    assert facts["facts"][-1]["citations"][0]["quote"] in source["text"]
    assert source["truncated"] is False and source["source_ref"] == "p1:facts"
    assert source["source_version"] == "7"


def test_index_adapter_preserves_date_roles_and_verbatim_multiline_date_evidence():
    facts = document_facts([{"page": 1}])
    quote = "Conference:\nJune 3–5, 2027\nDraft plan has no publication dates."
    status_quote = "Draft\nWitness: [name]\nPublication is not confirmed."
    facts["record_status"] = {
        "status": "draft",
        "evidence_basis": "documentary_form",
        "explanation": "The draft's publication has not been established.",
        "citations": [{"page": 1, "quote": status_quote}],
    }
    facts["date_evidence"] = [
        {
            "role": "event",
            "start": "2027-06-03",
            "end": "2027-06-05",
            "meaning": "Dates describe the conference, not publication coverage",
            "citations": [{"page": 1, "quote": quote}],
        }
    ]
    source = indexed_evidence_source(
        document_ref="p1",
        document={
            "source_version": "7",
            "facts_version": "v1",
            "metadata": {"name": "Draft.txt"},
            "facts": facts,
            "complete": True,
        },
    )
    assert '"role": "event"' in source["text"]
    # JSON serialization alone escapes newlines and cannot support the original
    # verbatim citation used by the request assessor.
    assert quote in source["text"]
    assert status_quote in source["text"]
    assert '"evidence_basis": "documentary_form"' in source["text"]


async def test_incomplete_or_disabled_index_explicitly_falls_back():
    facts = SimpleNamespace(
        current_index_status=AsyncMock(return_value={"complete": False, "signature": "a"})
    )
    service = DriveOwnerSearchService(
        store=SimpleNamespace(), transport=SimpleNamespace(), facts=facts
    )
    route = await service.request_evidence_route(user_id="owner")
    assert route["kind"] == "provider" and route["fallback_reason"] == "index_incomplete"
    facts.current_index_status.side_effect = DriveReadError("collection_processing_required")
    assert (await service.request_evidence_route(user_id="owner"))[
        "fallback_reason"
    ] == "collection_not_enabled"
    facts.current_index_status.side_effect = DriveReadError("connection_changed")
    with pytest.raises(DriveReadError, match="connection_changed"):
        await service.request_evidence_route(user_id="owner")


async def test_exact_packet_membership_resumes_across_pages_without_search_queries():
    packet = manifest(26)
    packets = SimpleNamespace(current_packet_manifest=AsyncMock(return_value=packet))

    async def read(**kwargs):
        assert kwargs["tool_name"] == "get_file_metadata"
        file_id = kwargs["arguments"]["fileId"]
        return SimpleNamespace(
            is_error=False,
            truncated=False,
            payload={
                "file": {
                    "id": file_id,
                    "title": "Statement" + file_id.removeprefix("file"),
                    "mimeType": "application/pdf",
                    "version": "7",
                    "modifiedTime": "2026-10-01T00:00:00Z",
                    "capabilities": {
                        "canShare": True,
                        "canDownload": True,
                        "canAccessViaGenAi": True,
                    },
                }
            },
        )

    transport = SimpleNamespace(read_tool=AsyncMock(side_effect=read))
    store = SimpleNamespace(require_current=AsyncMock())
    service = DriveOwnerSearchService(store=store, transport=transport, packets=packets)
    job = {
        "user_id": "owner",
        "checkpoint": {
            "evidence_route": "packet",
            "packet_offset": 0,
            "reusable_packet": binding(),
        },
    }
    checkpoint, first, incomplete, done = await service._page(job)
    assert len(first) == 25 and not incomplete and not done
    job["checkpoint"] = checkpoint
    _, last, incomplete, done = await service._page(job)
    assert len(last) == 1 and done and not incomplete
    assert {item["id"] for item in first + last} == {f"file{i}" for i in range(26)}
    assert transport.read_tool.await_count == 26


async def test_changed_provider_version_cannot_reuse_indexed_facts():
    packets = SimpleNamespace(current_packet_manifest=AsyncMock(return_value=manifest()))
    transport = SimpleNamespace(
        read_tool=AsyncMock(
            return_value=SimpleNamespace(
                is_error=False,
                truncated=False,
                payload={
                    "file": {
                        "id": "file0",
                        "title": "Statement0",
                        "mimeType": "application/pdf",
                        "version": "8",
                        "modifiedTime": "2026-10-01T00:00:00Z",
                        "capabilities": {"canShare": True},
                    }
                },
            )
        )
    )
    service = DriveOwnerSearchService(
        store=SimpleNamespace(require_current=AsyncMock()), transport=transport, packets=packets
    )
    with pytest.raises(DriveReadError, match="source_changed"):
        await service._page(
            {
                "user_id": "owner",
                "checkpoint": {
                    "evidence_route": "packet",
                    "packet_offset": 0,
                    "reusable_packet": binding(),
                },
            }
        )


async def test_partial_index_is_reused_before_visible_provider_fallback():
    doc = {
        "document_id": "doc0",
        "source_version": "7",
        "facts_version": "facts0",
        "metadata": {"file_id": "file0", "name": "Statement0"},
        "facts": {},
    }
    facts = SimpleNamespace(
        current_index_status=AsyncMock(
            return_value={"complete": False, "signature": "snap", "indexed": 1}
        ),
        current_documents_page=AsyncMock(return_value={"documents": [doc], "next_cursor": None}),
    )
    provider = SimpleNamespace(
        read_tool=AsyncMock(
            return_value=SimpleNamespace(
                is_error=False,
                truncated=False,
                payload={
                    "file": {
                        "id": "file0",
                        "title": "Statement0",
                        "mimeType": "application/pdf",
                        "version": "7",
                        "modifiedTime": "2026-10-01T00:00:00Z",
                        "capabilities": {"canShare": True, "canDownload": True},
                    }
                },
            )
        )
    )
    service = DriveOwnerSearchService(store=SimpleNamespace(), transport=provider, facts=facts)
    route = await service.request_evidence_route(user_id="owner")
    assert route["kind"] == "hybrid" and route["fallback_reason"] == "index_incomplete"
    checkpoint, files, incomplete, done = await service._page(
        {
            "user_id": "owner",
            "checkpoint": {
                "evidence_route": "hybrid",
                "phase": "index",
                "index_cursor": None,
                "index_snapshot": {"signature": "snap"},
            },
        }
    )
    assert checkpoint["phase"] == "user" and len(files) == 1 and not done and not incomplete
    assert files[0]["indexedEvidence"]["facts_version"] == "facts0"


async def test_catalogue_over_match_budget_never_picks_first_exact_packet():
    packets = SimpleNamespace(
        list_packets=AsyncMock(return_value={"packets": [], "nextCursor": "more"})
    )
    matcher = AsyncMock()
    service = DriveOwnerSearchService(
        store=SimpleNamespace(),
        transport=SimpleNamespace(),
        packets=packets,
        packet_matcher=matcher,
    )
    assert (
        await service._match_canonical_packet(user_id="owner", request={"purpose": "Statements"})
        is None
    )
    assert packets.list_packets.await_count == 2
    matcher.assert_not_awaited()


async def test_current_download_revocation_blocks_reused_index():
    packets = SimpleNamespace(current_packet_manifest=AsyncMock(return_value=manifest()))
    provider = SimpleNamespace(
        read_tool=AsyncMock(
            return_value=SimpleNamespace(
                is_error=False,
                truncated=False,
                payload={
                    "file": {
                        "id": "file0",
                        "title": "Statement0",
                        "mimeType": "application/pdf",
                        "version": "7",
                        "modifiedTime": "2026-10-01T00:00:00Z",
                        "capabilities": {"canShare": True, "canDownload": False},
                    }
                },
            )
        )
    )
    service = DriveOwnerSearchService(store=SimpleNamespace(), transport=provider, packets=packets)
    with pytest.raises(DriveReadError, match="source_unavailable"):
        await service._page(
            {
                "user_id": "owner",
                "checkpoint": {
                    "evidence_route": "packet",
                    "packet_offset": 0,
                    "reusable_packet": binding(),
                },
            }
        )


async def test_request_checker_rejects_wrong_account_even_when_matcher_says_exact():
    packet = manifest() | {
        "assessment": {"state": "ready", "selected_document_ids": ["doc0"]},
        "verification": {},
    }
    packets = SimpleNamespace(
        current_packet_manifest=AsyncMock(return_value=packet),
        list_packets=AsyncMock(
            return_value={
                "packets": [
                    {
                        "packetId": "packet",
                        "version": 1,
                        "state": "ready",
                        "freshness": "current",
                        "documentCount": 1,
                    }
                ],
                "nextCursor": None,
            }
        ),
    )
    facts = document_facts([{"page": 1}])
    facts["account"] = {
        "value": "account 2222",
        "citations": [{"page": 1, "quote": "Account 2222"}],
    }
    facts["date_evidence"] = [
        {
            "role": "as_of",
            "start": "2026-09-30",
            "end": "2026-09-30",
            "meaning": "Closing balance snapshot, distinct from the statement period",
            "citations": [{"page": 1, "quote": "Balance as of 30 September 2026"}],
        }
    ]
    current = {"complete": True, "signature": "unchanged", "indexed": 1}
    facts_store = SimpleNamespace(
        current_index_status=AsyncMock(return_value=current),
        current_document=AsyncMock(return_value={"facts": facts, "complete": True}),
    )
    checker = AsyncMock(return_value=SimpleNamespace(state="unable_to_verify"))
    service = DriveOwnerSearchService(
        store=SimpleNamespace(),
        transport=SimpleNamespace(),
        facts=facts_store,
        packets=packets,
        packet_matcher=AsyncMock(
            return_value=SimpleNamespace(decision="exact", packet_id="packet", version=1)
        ),
        packet_checker=checker,
    )
    request = {
        "purpose": "Statements for account 1111",
        "periodStart": "2026-09-01",
        "periodEnd": "2026-10-09",
    }
    route = await service.request_evidence_route(user_id="owner", request=request)
    assert route["kind"] == "index" and "matched_packet" not in route
    assert checker.call_args.kwargs["packet"]["document_request"] == request
    assert checker.call_args.kwargs["documents"][0]["account"] == "account 2222"
    expected_date = {
        key: value for key, value in facts["date_evidence"][0].items() if key != "citations"
    }
    assert checker.call_args.kwargs["documents"][0]["date_evidence"] == [expected_date]
    matched_evidence = service.packet_matcher.call_args.kwargs["packets"][0][
        "current_source_facts"
    ][0]
    assert matched_evidence["date_evidence"] == [expected_date]
    assert matched_evidence["content_periods"] == [
        {"start": item["start"], "end": item["end"]} for item in facts["periods"]
    ]
