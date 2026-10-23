"""Real package persistence and authority races in disposable PostgreSQL only."""

# ruff: noqa: F811 -- imported disposable database fixtures

import asyncio
import json
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from hushh_mcp.services.drive_request_package_store import DriveRequestPackageStore
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_request_bulk_postgres import (  # noqa: F401
    MIGRATIONS,
    _request,
    _search,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    request_bulk,
    sharing,
)


@pytest.fixture
def packages(request_bulk, sharing):
    with sharing.db.engine.begin() as connection:
        connection.execute(text((MIGRATIONS / "328_drive_request_packages.sql").read_text()))
        connection.execute(text((MIGRATIONS / "328_drive_request_packages.sql").read_text()))
    return DriveRequestPackageStore(db=sharing.db, sharing=sharing)


async def request_search(packages, request_bulk, sharing, count=46, *, names=None, selection=None):
    request_id = (await _request(sharing))["requestId"]
    with sharing.db.engine.begin() as connection:
        row = sharing._request(connection, "owner", request_id)
        private = {**sharing._open_request(row), "agent_package_required": True}
        connection.execute(
            text(
                "UPDATE drive_share_requests SET request_envelope=CAST(:envelope AS jsonb),agent_package_required=TRUE WHERE request_id=:request"
            ),
            {
                "request": request_id,
                "envelope": json.dumps(
                    sharing.sharing_cipher.seal(
                        private, user_id="owner", resource_id=request_id, purpose="request"
                    )
                ),
            },
        )
    return request_id, _search(
        request_bulk, request_id=request_id, count=count, names=names, selection=selection
    )


def observations(job, *, unreadable=False):
    return [
        {
            "position": item["position"],
            "source_version": None if unreadable else "7",
            "content_fingerprint": None if unreadable else "a" * 64,
            "assessment_policy_version": "test-v1",
            "unreadable_reason": "no_extractable_text" if unreadable else None,
            "assessment": None
            if unreadable
            else {
                "document_ref": item["document_ref"],
                "source_version": "7",
                "decision": "include",
                "confidence": 92,
                "reason": "Requested synthetic statement.",
                "citations": [{"source_ref": f"s{item['position']}", "quote": "Statement period"}],
                "covered_periods": [],
            },
            "truncated": False,
        }
        for item in job["candidates"]
    ]


def assessment(count, **changes):
    return {
        "decision": "partial",
        "coverage_status": "partial",
        "selected_document_refs": [f"p{i}" for i in range(1, count + 1)],
        "confidence": 92,
        "importance": 175,
        "suggested_price_cents": 1250,
        "rationale": "Useful records with incomplete coverage.",
        "coverage_summary": "Requested records found; coverage remains partial.",
        "gaps": ["The complete requested period is not evidenced."],
        **changes,
    }


async def evaluate_all(packages, search):
    claims = 0
    while True:
        job = await packages.claim_evaluation(user_id="owner", job_id=search)
        if not job["candidates"]:
            return job, claims
        assert len(job["candidates"]) <= 6
        await packages.commit_evaluations(job, observations=observations(job))
        await packages.release_evaluation(job)
        claims += 1


async def test_46_candidates_survive_restart_and_package_digest_binds_all_sources(
    packages, request_bulk, sharing
):
    request_id, search = await request_search(packages, request_bulk, sharing)
    assert len(await packages.due_evaluations()) == 1
    job, claims = await evaluate_all(packages, search)
    assert claims == 8
    page = await packages.package_evidence_page(job, limit=25)
    assert page["counts"] == {"candidates": 46, "evaluated": 46}
    assert len(page["items"]) == 25 and page["next_position"] == 25
    assert len((await packages.package_evidence_page(job, after_position=25))["items"]) == 21
    ready = await packages.finalize_package(
        job, assessment=assessment(46), policy_version="test-v1"
    )
    assert ready["status"] == "ready" and ready["canAllow"] is True
    assert ready["selectedCount"] == 46 and ready["suggestedPriceCents"] == 1250
    restarted = DriveRequestPackageStore(db=sharing.db, sharing=sharing)
    assert await restarted.package_review(user_id="owner", request_id=request_id) == ready
    with sharing.db.engine.begin() as connection:
        row = sharing._request(connection, "owner", request_id)
        result = restarted.validate_ready_package(
            connection, row, sharing._open_request(row), ready["revision"], ready["digest"]
        )
        assert result["selected_positions"] == list(range(1, 47))
        assert len(result["selected_sources"]) == 46
        raw = (
            connection.execute(
                text(
                    "SELECT evaluation_envelope::text FROM drive_owner_search_results WHERE job_id=:job"
                ),
                {"job": search},
            )
            .scalars()
            .all()
        )
        assert "Statement period" not in str(raw)
        checkpoint = restarted._checkpoint(
            connection.execute(
                text("SELECT * FROM drive_owner_search_jobs WHERE job_id=:job"), {"job": search}
            )
            .mappings()
            .one()
        )
        assert "citations" not in json.dumps(checkpoint)
        assert connection.execute(text("SELECT count(*) FROM drive_bulk_shares")).scalar_one() == 0
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders")
            ).scalar_one()
            == 0
        )


async def provider_packet_search(packages, request_bulk, sharing, monkeypatch):
    from hushh_mcp.services.drive_request_discovery import discovery_evidence
    from hushh_mcp.services.drive_request_semantic_plan import semantic_plan_digest

    request_id, search = await request_search(packages, request_bulk, sharing, count=2)
    packet_id = str(uuid4())
    plan = {
        "version": 1,
        "status": "ready",
        "date_basis": "modified",
        "clauses": [],
        "metadata_listing": True,
        "clarification": None,
    }
    # The semantic parser owns full plan validation. These query bindings are
    # synthetic, while this test exercises real request locks and persistence.
    queries = [{"arguments": {"query": "trashed = false"}}]
    binding = {
        "ownerUserId": "owner",
        "packetId": packet_id,
        "version": 1,
        "manifestDigest": "c" * 64,
        "listingRevision": 1,
        "priceCents": 500,
    }
    metadata, sources = {}, []
    with sharing.db.engine.begin() as connection:
        request = sharing._request(connection, "owner", request_id)
        row = packages._owned(connection, "owner", search)
        checkpoint = packages._checkpoint(row)
        checkpoint.update(provider_packet=True, reusable_packet=binding)
        provenance = {
            "queries": queries,
            "semantic_plan": plan,
            "query_index": 0,
            "semantic_plan_digest": semantic_plan_digest(plan),
            "request_origin_id": request_id,
            "request_revision": request["revision"],
            "requested_period": {"start": "2026-01-01", "end": "2026-02-28", "timezone": "UTC"},
        }
        for item in connection.execute(
            text("SELECT * FROM drive_owner_search_results WHERE job_id=:job ORDER BY position"),
            {"job": search},
        ).mappings():
            value = packages.search_cipher.open(
                item["metadata_envelope"],
                user_id="owner",
                resource_id=f"{search}:{item['position']}",
                purpose="owner-search-result",
            )
            identity = str(uuid4())
            value.update(
                providerPacketDocumentId=identity,
                providerPacketId=packet_id,
                providerPacketVersion=1,
                sourceVersion="7",
            )
            value["discoveryEvidence"] = discovery_evidence(
                provenance, user_id="owner", generation=1, metadata=value
            )
            metadata[identity] = dict(value)
            sources.append({"document_id": identity, "source_version": "7"})
            connection.execute(
                text("""UPDATE drive_owner_search_results
                SET metadata_envelope=CAST(:envelope AS jsonb) WHERE job_id=:job AND position=:position"""),
                {
                    "job": search,
                    "position": item["position"],
                    "envelope": packages._seal(
                        value, "owner", f"{search}:{item['position']}", "owner-search-result"
                    ),
                },
            )
        private = {**sharing._open_request(request), "reusable_packet": binding}
        connection.execute(
            text("""UPDATE drive_share_requests SET request_envelope=CAST(:envelope AS jsonb)
            WHERE request_id=:request"""),
            {
                "request": request_id,
                "envelope": json.dumps(
                    sharing.sharing_cipher.seal(
                        private, user_id="owner", resource_id=request_id, purpose="request"
                    )
                ),
            },
        )
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET checkpoint_envelope=CAST(:envelope AS jsonb)
            WHERE job_id=:job"""),
            {
                "job": search,
                "envelope": packages._seal(checkpoint, "owner", search, "owner-search-checkpoint"),
            },
        )
    manifest = {
        "schema_version": 2,
        "kind": "provider_discovery",
        "digest": "c" * 64,
        "packet_id": packet_id,
        "version": 1,
        "connection_generation": 1,
        "periodStart": "2026-01-01",
        "periodEnd": "2026-02-28",
        "timezone": "UTC",
        "sources": sources,
        "source_metadata": metadata,
        "selected_document_ids": list(metadata),
        "search": {"queries": queries, "plan": plan},
        "price_cents": 500,
    }
    # The catalog's separate current-version tests cover its authority. Preserve
    # a fixed exact manifest here without requiring extracted facts or content.
    monkeypatch.setattr(packages, "_provider_manifest", lambda *_a, **_k: manifest)
    return request_id, search, manifest


@pytest.mark.parametrize(
    "tamper", [None, "member", "source", "request", "query", "content", "partial"]
)
async def test_provider_packet_freeze_binds_all_metadata_without_fabricated_assessment(
    packages, request_bulk, sharing, monkeypatch, tamper
):
    request_id, search, manifest = await provider_packet_search(
        packages, request_bulk, sharing, monkeypatch
    )
    if tamper is not None:
        with sharing.db.engine.begin() as connection:
            item = (
                connection.execute(
                    text("""SELECT * FROM drive_owner_search_results
                WHERE job_id=:job AND position=1"""),
                    {"job": search},
                )
                .mappings()
                .one()
            )
            value = packages.search_cipher.open(
                item["metadata_envelope"],
                user_id="owner",
                resource_id=f"{search}:1",
                purpose="owner-search-result",
            )
            if tamper == "member":
                value["providerPacketDocumentId"] = str(uuid4())
            elif tamper == "source":
                value["sourceVersion"] = "8"
            elif tamper == "request":
                value["discoveryEvidence"]["request_id"] = str(uuid4())
            elif tamper == "query":
                value["discoveryEvidence"]["query_digest"] = "d" * 64
            elif tamper == "content":
                value["contentVerified"] = True
            else:
                manifest["selected_document_ids"].pop()
            connection.execute(
                text("""UPDATE drive_owner_search_results
                SET metadata_envelope=CAST(:envelope AS jsonb) WHERE job_id=:job AND position=1"""),
                {
                    "job": search,
                    "envelope": packages._seal(
                        value, "owner", f"{search}:1", "owner-search-result"
                    ),
                },
            )
    job = await packages.claim_evaluation(user_id="owner", job_id=search)
    if tamper:
        with pytest.raises(DriveSharingError, match="package_changed"):
            await packages.finalize_provider_packet(job)
        return
    ready = await packages.finalize_provider_packet(job)
    assert ready["canAllow"] and ready["selectedCount"] == 2
    assert ready["confidenceBasis"] == "provider_search" and ready["confidenceScore"] is None
    assert ready["evaluatedCount"] == 0 and ready["coverageStatus"] == "unknown"
    with sharing.db.engine.begin() as connection:
        request = sharing._request(connection, "owner", request_id)
        validated = packages.validate_ready_package(
            connection, request, sharing._open_request(request), ready["revision"], ready["digest"]
        )
        assert validated["buyer_disclosure"]["confidenceBasis"] == "provider_search"
        assert validated["buyer_disclosure"]["periods"] == []
        assert all(
            s["fingerprint_basis"] == "provider_metadata" for s in validated["selected_sources"]
        )
        assert (
            connection.execute(
                text(
                    "SELECT count(evaluated_at) FROM drive_owner_search_results WHERE job_id=:job"
                ),
                {"job": search},
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders")
            ).scalar_one()
            == 0
        )
        assert request["owner_allowed_at"] is None
        row = packages._owned(connection, "owner", search)
        assert "assessment" not in packages._checkpoint(row)["agent_package"]


async def test_provider_only_claim_leaves_historical_content_package_unleased(
    packages, request_bulk, sharing
):
    _, search = await request_search(packages, request_bulk, sharing, count=1)
    assert (
        await packages.claim_evaluation(user_id="owner", job_id=search, provider_only=True) is None
    )
    with sharing.db.engine.connect() as connection:
        row = packages._owned(connection, "owner", search)
        assert row["evaluation_status"] == "pending" and row["lease_id"] is None


async def test_failed_discovery_is_not_reported_as_endless_package_preparation(
    packages, request_bulk, sharing
):
    request_id, search = await request_search(packages, request_bulk, sharing, count=25)
    lease = str(uuid4())
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET status='running',
                 evaluation_status='pending',lease_id=:lease,
                 lease_expires_at=clock_timestamp()+INTERVAL '1 minute'
                 WHERE job_id=:job"""),
            {"job": search, "lease": lease},
        )
    assert (
        await packages.release(
            {"user_id": "owner", "job_id": search, "lease_id": lease},
            error="operation_not_allowed",
        )
        == "failed"
    )
    review = await packages.package_review(user_id="owner", request_id=request_id)
    assert review["status"] == "unavailable"
    assert review["searchErrorCode"] == "provider_unavailable"
    assert review["candidateCount"] == 25
    assert review["canAllow"] is False
    with sharing.db.engine.begin() as connection:
        failed = (
            connection.execute(
                text("SELECT * FROM drive_owner_search_jobs WHERE job_id=:job"), {"job": search}
            )
            .mappings()
            .one()
        )
        assert failed["error_code"] == "provider_unavailable"
        assert packages._checkpoint(failed)["last_search_failure_cause"] == "operation_not_allowed"
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == 0
        )


async def test_failed_request_retry_keeps_job_cursor_results_and_batch_identity(
    packages, request_bulk, sharing
):
    request_id, search = await request_search(packages, request_bulk, sharing, count=25)
    with sharing.db.engine.begin() as connection:
        row = (
            connection.execute(
                text("SELECT * FROM drive_owner_search_jobs WHERE job_id=:job"),
                {"job": search},
            )
            .mappings()
            .one()
        )
        checkpoint = packages._checkpoint(row)
        checkpoint.update(
            authority_mode="agent_package",
            page_token="next-provider-page",  # noqa: S106 - synthetic provider cursor
            v1_live_request=True,
            last_search_failure_cause="operation_not_allowed",
        )
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET status='failed',
                error_code='provider_unavailable',matched=25,
                checkpoint_envelope=CAST(:checkpoint AS jsonb) WHERE job_id=:job"""),
            {
                "job": search,
                "checkpoint": packages._seal(
                    checkpoint, "owner", search, "owner-search-checkpoint"
                ),
            },
        )
    recovered, changed = await packages.retry_failed_request(
        user_id="owner",
        request_id=request_id,
        request_revision=checkpoint["request_revision"],
        authority_mode="agent_package",
    )
    assert changed is True
    assert recovered["status"] == "queued" and recovered["jobId"] == search
    with sharing.db.engine.begin() as connection:
        row = (
            connection.execute(
                text("SELECT * FROM drive_owner_search_jobs WHERE job_id=:job"),
                {"job": search},
            )
            .mappings()
            .one()
        )
        assert packages._checkpoint(row)["page_token"] == "next-provider-page"
        assert packages._checkpoint(row)["last_recovered_error_code"] == "provider_unavailable"
        assert packages._checkpoint(row)["last_search_failure_cause"] == "operation_not_allowed"
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_owner_search_results WHERE job_id=:job"),
                {"job": search},
            ).scalar_one()
            == 25
        )
        assert (
            connection.execute(text("SELECT count(*) FROM drive_owner_search_jobs")).scalar_one()
            == 1
        )
    repeated, changed = await packages.retry_failed_request(
        user_id="owner",
        request_id=request_id,
        request_revision=checkpoint["request_revision"],
        authority_mode="agent_package",
    )
    assert changed is False and repeated["jobId"] == search


async def test_v1_first_25_prioritizes_hints_then_resumes_every_generic_and_old_file(
    packages, request_bulk, sharing, monkeypatch
):
    names = {
        1: "scan0001.pdf",
        2: "Schwab statement 2016.pdf",
        3: "financial report 2026.pdf",
        4: "misc.pdf",
        5: "untitled.pdf",
        **{position: f"Schwab statement 2026 #{position}.pdf" for position in range(6, 31)},
    }
    request_id, search = await request_search(
        packages,
        request_bulk,
        sharing,
        count=30,
        names=names,
        selection={
            "v1_live_request": True,
            "authored_plan": {
                "required_entities": ["Schwab"],
                "terms": ["statement"],
                "discovery_clues": ["eStmt", "account"],
                "expected_document_anatomy": "Statement account balances",
            },
        },
    )
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_owner_search_jobs SET v1_statement_search=TRUE WHERE job_id=:job"),
            {"job": search},
        )
    visited = []
    sizes = []
    while len(visited) < 25:
        job = await packages.claim_evaluation(user_id="owner", job_id=search, v1_only=True)
        sizes.append(len(job["candidates"]))
        visited.extend(item["position"] for item in job["candidates"])
        assert job["candidate_count"] == 30
        assert job["remaining"] == 30 - len(visited)
        assert all(
            item["metadata"]["name"] == names[item["position"]] for item in job["candidates"]
        )
        await packages.commit_evaluations(job, observations=observations(job, unreadable=True))
        await packages.release_evaluation(job)
        if len(sizes) == 1:
            # The encrypted priority cohort survives worker restart; no
            # subsequent claim decrypts/ranks the entire collection again.
            packages = DriveRequestPackageStore(db=sharing.db, sharing=sharing)
            monkeypatch.setattr(
                "hushh_mcp.services.drive_request_package_store._metadata_priority",
                lambda *_args, **_kwargs: pytest.fail("priority must be reused after restart"),
            )
    assert sizes == [6, 6, 6, 6, 1]
    assert visited == list(range(6, 31))
    public = await packages.package_review(user_id="owner", request_id=request_id)
    assert public["candidateCount"] == 30 and public["evaluatedCount"] == 25
    assert public["status"] == "preparing" and public["canAllow"] is False

    tail = await packages.claim_evaluation(user_id="owner", job_id=search, v1_only=True)
    assert [item["position"] for item in tail["candidates"]] == [1, 2, 3, 4, 5]
    # Neither a generic filename nor an old filename was rejected. Even
    # before the final tail is read, assembly still refuses false completion.
    with pytest.raises(DriveSharingError, match="package_incomplete"):
        await packages.finalize_package(
            tail,
            assessment=assessment(0, decision="insufficient_evidence", coverage_status="unknown"),
            policy_version="test-v1",
        )
    await packages.commit_evaluations(tail, observations=observations(tail, unreadable=True))
    await packages.release_evaluation(tail)
    visited.extend(item["position"] for item in tail["candidates"])
    final = await packages.claim_evaluation(user_id="owner", job_id=search, v1_only=True)
    assert final["candidates"] == [] and final["remaining"] == 0
    assert sorted(visited) == list(range(1, 31))
    evidence = await packages.package_evidence_page(final)
    assert evidence["counts"] == {"candidates": 30, "evaluated": 30}


async def test_concurrent_claim_and_expired_lease_fence_late_observations(
    packages, request_bulk, sharing
):
    _, search = await request_search(packages, request_bulk, sharing, count=2)
    results = await asyncio.gather(
        *(packages.claim_evaluation(user_id="owner", job_id=search) for _ in range(2))
    )
    assert sum(item is not None for item in results) == 1
    old = next(item for item in results if item)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_owner_search_jobs SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE job_id=:job"
            ),
            {"job": search},
        )
    fresh = await packages.claim_evaluation(user_id="owner", job_id=search)
    with pytest.raises(DriveSharingError, match="package_changed"):
        await packages.commit_evaluations(old, observations=observations(old))
    await packages.commit_evaluations(fresh, observations=observations(fresh))


@pytest.mark.parametrize(
    "change", ["request_revision", "connection_generation", "background_off", "disconnect", "deny"]
)
async def test_authority_change_discards_late_read(packages, request_bulk, sharing, change):
    request_id, search = await request_search(packages, request_bulk, sharing, count=1)
    job = await packages.claim_evaluation(user_id="owner", job_id=search)
    with sharing.db.engine.begin() as connection:
        statements = {
            "request_revision": "UPDATE drive_share_requests SET revision=revision+1 WHERE request_id=:request",
            "connection_generation": "UPDATE user_external_connector_connections SET connection_generation=connection_generation+1 WHERE user_id='owner'",
            "background_off": "INSERT INTO drive_live_preferences(user_id,connection_generation,background_enabled) VALUES('owner',1,FALSE)",
            "disconnect": "UPDATE connections SET status='disconnected' WHERE user_a_id='owner' AND user_b_id='recipient'",
            "deny": "UPDATE drive_share_requests SET status='declined' WHERE request_id=:request",
        }
        connection.execute(text(statements[change]), {"request": request_id})
    with pytest.raises(DriveReadError):
        await packages.commit_evaluations(job, observations=observations(job))
    with sharing.db.engine.begin() as connection:
        assert (
            connection.execute(
                text(
                    "SELECT count(evaluated_at) FROM drive_owner_search_results WHERE job_id=:job"
                ),
                {"job": search},
            ).scalar_one()
            == 0
        )


async def test_finalization_cannot_hide_unread_candidates_or_invent_selected_refs(
    packages, request_bulk, sharing
):
    _, search = await request_search(packages, request_bulk, sharing, count=7)
    job = await packages.claim_evaluation(user_id="owner", job_id=search)
    await packages.commit_evaluations(job, observations=observations(job))
    with pytest.raises(DriveSharingError, match="package_incomplete"):
        await packages.finalize_package(job, assessment=assessment(6), policy_version="test-v1")
    await packages.release_evaluation(job)
    job = await packages.claim_evaluation(user_id="owner", job_id=search)
    await packages.commit_evaluations(job, observations=observations(job, unreadable=True))
    with pytest.raises(DriveSharingError, match="package_changed"):
        await packages.finalize_package(job, assessment=assessment(7), policy_version="test-v1")
    with pytest.raises(DriveSharingError, match="package_incomplete"):
        await packages.finalize_package(
            job,
            assessment=assessment(6, decision="ready", coverage_status="complete", gaps=[]),
            policy_version="test-v1",
        )
    ready = await packages.finalize_package(job, assessment=assessment(6), policy_version="test-v1")
    assert ready["unreadableCount"] == 1 and ready["coverageStatus"] == "partial"


@pytest.mark.parametrize("unreadable", [False, True])
async def test_v1_no_match_closes_only_fully_read_request_and_emits_feed_outcome(
    packages, request_bulk, sharing, unreadable
):
    request_id, search = await request_search(packages, request_bulk, sharing, count=1)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_owner_search_jobs SET v1_statement_search=TRUE WHERE job_id=:job"),
            {"job": search},
        )
    job = await packages.claim_evaluation(user_id="owner", job_id=search)
    values = observations(job, unreadable=unreadable)
    if not unreadable:
        values[0]["assessment"].update(decision="exclude", reason="Wrong document type.")
    await packages.commit_evaluations(job, observations=values)
    result = await packages.finalize_package(
        job,
        assessment=assessment(
            0,
            decision="no_match",
            coverage_status="unknown",
            gaps=[],
            coverage_summary="No verified matching documents.",
        ),
        policy_version="test-v1-no-match",
    )
    with sharing.db.engine.begin() as connection:
        request = sharing._request(connection, "owner", request_id)
        events = connection.execute(
            text("""SELECT user_id,event_type FROM drive_share_events
                WHERE request_id=:request AND event_type='document_share_outcome'"""),
            {"request": request_id},
        ).all()
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders")
            ).scalar_one()
            == 0
        )
        assert connection.execute(text("SELECT count(*) FROM drive_bulk_shares")).scalar_one() == 0
    if unreadable:
        assert result["status"] == "unavailable"
        assert request["status"] == "pending"
        assert events == []
    else:
        assert result["status"] == "no_match"
        assert request["status"] == "no_match"
        assert set(events) == {
            ("owner", "document_share_outcome"),
            ("recipient", "document_share_outcome"),
        }
        assert (await packages.package_review(user_id="owner", request_id=request_id))[
            "status"
        ] == "no_match"


async def test_ready_digest_rejects_changed_version_evidence(packages, request_bulk, sharing):
    request_id, search = await request_search(packages, request_bulk, sharing, count=1)
    job, _ = await evaluate_all(packages, search)
    ready = await packages.finalize_package(job, assessment=assessment(1), policy_version="test-v1")
    with sharing.db.engine.begin() as connection:
        row = (
            connection.execute(
                text("SELECT * FROM drive_owner_search_jobs WHERE job_id=:job"), {"job": search}
            )
            .mappings()
            .one()
        )
        evidence = packages._evidence(connection, row)[0]
        evidence["source_version"] = "8"
        connection.execute(
            text(
                "UPDATE drive_owner_search_results SET evaluation_envelope=CAST(:envelope AS jsonb) WHERE job_id=:job"
            ),
            {
                "job": search,
                "envelope": packages._seal(
                    evidence, "owner", f"{search}:1", "request-package-evidence"
                ),
            },
        )
    with sharing.db.engine.begin() as connection:
        request = sharing._request(connection, "owner", request_id)
        with pytest.raises(DriveSharingError, match="package_changed"):
            packages.validate_ready_package(
                connection,
                request,
                sharing._open_request(request),
                ready["revision"],
                ready["digest"],
            )


async def test_legacy_request_has_no_package_and_paid_history_cannot_be_evaluated(
    packages, request_bulk, sharing
):
    legacy = (await _request(sharing))["requestId"]
    _search(request_bulk, request_id=legacy, count=1)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_share_requests SET agent_package_required=TRUE WHERE request_id=:request"
            ),
            {"request": legacy},
        )
    assert await packages.package_review(user_id="owner", request_id=legacy) is None
    assert await packages.due_evaluations() == []
    request_id, search = await request_search(packages, request_bulk, sharing, count=1)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
          (request_id,user_id,requester_user_id,amount_cents)
          VALUES(:request,'owner','recipient',1000)"""),
            {"request": request_id},
        )
    assert await packages.due_evaluations() == []
    with pytest.raises(DriveSharingError, match="package_frozen"):
        await packages.claim_evaluation(user_id="owner", job_id=search)


@pytest.mark.parametrize("unreadable", [False, True])
async def test_policy_version_is_required_for_every_read_outcome(
    packages, request_bulk, sharing, unreadable
):
    _, search = await request_search(packages, request_bulk, sharing, count=1)
    job = await packages.claim_evaluation(user_id="owner", job_id=search)
    values = observations(job, unreadable=unreadable)
    values[0].pop("assessment_policy_version")
    with pytest.raises(ValueError, match="policy version"):
        await packages.commit_evaluations(job, observations=values)
    with sharing.db.engine.begin() as connection:
        assert (
            connection.execute(
                text(
                    "SELECT count(evaluated_at) FROM drive_owner_search_results WHERE job_id=:job"
                ),
                {"job": search},
            ).scalar_one()
            == 0
        )


async def test_cent_migration_replay_preserves_existing_orders_and_does_not_block_writers(
    packages, request_bulk, sharing
):
    request_id, _ = await request_search(packages, request_bulk, sharing, count=1)
    with sharing.db.engine.begin() as connection:
        connection.execute(text((MIGRATIONS / "329_drive_request_cent_prices.sql").read_text()))
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
          (request_id,user_id,requester_user_id,amount_cents)
          VALUES(:request,'owner','recipient',51)"""),
            {"request": request_id},
        )
        connection.execute(
            text("UPDATE drive_request_owner_pricing SET amount_cents=50 WHERE user_id='owner'")
        )
        connection.execute(
            text("""UPDATE drive_share_requests SET quoted_amount_cents=125,
          initial_quote_cents=50,quote_version=1 WHERE request_id=:request"""),
            {"request": request_id},
        )
    # Replaying both predecessors and successors must preserve cents and take
    # no ACCESS EXCLUSIVE table lock once installed.
    with sharing.db.engine.connect() as writer:
        writer.exec_driver_sql("""LOCK TABLE drive_share_requests,drive_request_payment_orders,
          drive_request_payment_obligations,drive_request_owner_pricing,drive_request_owner_payouts,
          drive_owner_search_jobs,drive_owner_search_results IN ROW EXCLUSIVE MODE""")
        try:
            for name in (
                "291_drive_request_owner_allowed.sql",
                "328_drive_request_packages.sql",
                "329_drive_request_cent_prices.sql",
            ):
                with sharing.db.engine.connect() as reader:
                    raw = reader.connection.driver_connection
                    with raw.cursor() as cursor:
                        cursor.execute("SET LOCAL lock_timeout = '500ms'")
                        cursor.execute((MIGRATIONS / name).read_text())
                    raw.commit()
        finally:
            writer.rollback()
    with sharing.db.engine.begin() as connection:
        assert (
            connection.execute(
                text(
                    "SELECT amount_cents FROM drive_request_payment_orders WHERE request_id=:request"
                ),
                {"request": request_id},
            ).scalar_one()
            == 51
        )
        assert (
            connection.execute(
                text(
                    "SELECT amount_cents FROM drive_request_payment_obligations WHERE request_id=:request"
                ),
                {"request": request_id},
            ).scalar_one()
            == 51
        )
    for invalid in (49, 50001):
        with pytest.raises(IntegrityError), sharing.db.engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE drive_request_owner_pricing SET amount_cents=:amount WHERE user_id='owner'"
                ),
                {"amount": invalid},
            )


async def test_background_pause_retains_retryable_work(packages, request_bulk, sharing):
    _, search = await request_search(packages, request_bulk, sharing, count=1)
    job = await packages.claim_evaluation(user_id="owner", job_id=search)
    assert (
        await packages.release_evaluation(job, error="background_preparation_required") == "pending"
    )
    with sharing.db.engine.begin() as connection:
        row = (
            connection.execute(
                text(
                    "SELECT evaluation_status,evaluation_attempts FROM drive_owner_search_jobs WHERE job_id=:job"
                ),
                {"job": search},
            )
            .mappings()
            .one()
        )
        assert row["evaluation_attempts"] == 0 and row["evaluation_status"] == "pending"
        connection.execute(
            text(
                "UPDATE drive_owner_search_jobs SET evaluation_next_at=clock_timestamp() WHERE job_id=:job"
            ),
            {"job": search},
        )
    assert (await packages.claim_evaluation(user_id="owner", job_id=search))["candidates"]


async def test_v1_verified_preview_does_not_authorize_pending_candidates(
    packages, request_bulk, sharing
):
    request_id, search = await request_search(packages, request_bulk, sharing, count=8)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_owner_search_jobs SET v1_statement_search=TRUE WHERE job_id=:job"),
            {"job": search},
        )
    job = await packages.claim_evaluation(user_id="owner", job_id=search)
    values = observations(job)
    for value in values:
        value["assessment"]["weightage_out_of_10"] = 8.5
    await packages.commit_evaluations(job, observations=values)
    preview = await packages.package_review(user_id="owner", request_id=request_id)
    assert preview["status"] == "preparing"
    assert preview["canAllow"] is False
    assert preview["verifiedCount"] == 6
    assert preview["pendingCount"] == 2
    assert len(preview["provisionalFiles"]) == 6
    assert preview["selectedCount"] == 0
    with sharing.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders")
            ).scalar_one()
            == 0
        )
        assert connection.execute(text("SELECT count(*) FROM drive_bulk_shares")).scalar_one() == 0
