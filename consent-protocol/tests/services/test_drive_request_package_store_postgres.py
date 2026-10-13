"""Real package persistence and authority races in disposable PostgreSQL only."""

# ruff: noqa: F811 -- imported disposable database fixtures

import asyncio
import json

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
        connection.execute(text((MIGRATIONS / "327_drive_request_packages.sql").read_text()))
        connection.execute(text((MIGRATIONS / "327_drive_request_packages.sql").read_text()))
    return DriveRequestPackageStore(db=sharing.db, sharing=sharing)


async def request_search(packages, request_bulk, sharing, count=46):
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
    return request_id, _search(request_bulk, request_id=request_id, count=count)


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
        connection.execute(text((MIGRATIONS / "328_drive_request_cent_prices.sql").read_text()))
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
                "327_drive_request_packages.sql",
                "328_drive_request_cent_prices.sql",
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
