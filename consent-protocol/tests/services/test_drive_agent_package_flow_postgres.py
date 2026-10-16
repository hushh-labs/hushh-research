"""Allow/Deny package integration against real, disposable PostgreSQL."""

# ruff: noqa: F811 -- shared disposable PostgreSQL fixtures

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.runtime_settings import clear_runtime_settings_caches
from hushh_mcp.services import drive_trusted_auto_service as automatic_module
from hushh_mcp.services.drive_owner_allowed import package_allow_marker
from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_request_bulk_service import DriveRequestBulkService
from hushh_mcp.services.drive_request_review_policy import request_requires_owner_review
from hushh_mcp.services.drive_sharing_contract import (
    DriveSharingError,
    ShareRequestPurpose,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.drive_trusted_auto_service import DriveTrustedAutoService
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_request_bulk_postgres import _recipient, _search
from tests.services.test_drive_request_package_store_postgres import (  # noqa: F401
    MIGRATIONS,
    assessment,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    observations,
    packages,
    request_bulk,
    sharing,
)


@pytest.fixture
def agent_flow(packages, sharing, monkeypatch):
    monkeypatch.setenv("DRIVE_AGENT_PACKAGES_ENABLED", "true")
    clear_runtime_settings_caches()
    with sharing.db.engine.begin() as connection:
        connection.execute(text((MIGRATIONS / "329_drive_request_cent_prices.sql").read_text()))
    yield packages
    clear_runtime_settings_caches()


def recipient():
    return VerifiedGoogleRecipient("recipient", "1234567", "b@example.invalid", datetime.now(UTC))


async def new_request(
    sharing, *, client_id=None, expected_quote_version=1, purpose_text="Portfolio reports"
):
    today = datetime.now(UTC).date()
    return await sharing.create_request(
        recipient=recipient(),
        owner_user_id="owner",
        client_request_id=client_id or str(uuid4()),
        expected_quote_version=expected_quote_version,
        purpose=ShareRequestPurpose(
            purpose=purpose_text,
            periodStart=(today - timedelta(days=42)).isoformat(),
            periodEnd=today.isoformat(),
        ),
    )


def private_request(sharing, request_id):
    with sharing.db.engine.begin() as connection:
        row = sharing._request(connection, "owner", request_id)
        return row, sharing._open_request(row)


async def prepared_package(agent_flow, request_bulk, sharing, *, count=46, selected=30):
    created = await new_request(sharing)
    request_id = created["requestId"]
    search = _search(
        request_bulk,
        request_id=request_id,
        count=count,
        selection={
            "agent_package_required": True,
            "authority_mode": "agent_package",
            "request_selection_version": 2,
            "request_time_intent": "document_coverage",
            "request_owner_review_required": True,
        },
    )
    while True:
        job = await agent_flow.claim_evaluation(user_id="owner", job_id=search)
        if not job["candidates"]:
            break
        values = observations(job)
        for value in values:
            if value["position"] > selected:
                value["assessment"].update(decision="exclude", reason="Unrelated old record.")
        await agent_flow.commit_evaluations(job, observations=values)
        await agent_flow.release_evaluation(job)
    ready = await agent_flow.finalize_package(
        job, assessment=assessment(selected), policy_version="test-integration-v1"
    )
    return created, search, ready


async def allow(sharing, created, ready, **changes):
    return await sharing.allow_request(
        **{
            "user_id": "owner",
            "request_id": created["requestId"],
            "revision": created["revision"],
            "amount_cents": 125,
            "package_revision": ready["revision"],
            "package_digest": ready["digest"],
            **changes,
        }
    )


async def test_new_live_request_prepares_without_prior_trust_allow_price_or_payout(
    agent_flow, sharing
):
    with sharing.db.engine.begin() as connection:
        connection.execute(text("DELETE FROM drive_request_owner_pricing WHERE user_id='owner'"))
        connection.execute(text("DELETE FROM stripe_owner_payout_accounts WHERE user_id='owner'"))
    created = await new_request(sharing, expected_quote_version=None)
    row, private = private_request(sharing, created["requestId"])
    assert private["agent_package_required"] is True
    assert row["agent_package_required"] is True
    assert private.get("trusted_auto") is not True and row["owner_allowed_at"] is None
    assert row["quoted_amount_cents"] is None
    await sharing.package_preparation_authority(user_id="owner", request_id=created["requestId"])
    assert created["requestId"] in {
        item["request_id"] for item in await sharing.due_trusted_searches(limit=4)
    }
    view = await sharing.owner_review(user_id="owner", request_id=created["requestId"])
    assert view["agentPackage"]["status"] == "preparing"
    assert view["agentPackage"]["canAllow"] is False
    with sharing.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders")
            ).scalar_one()
            == 0
        )
        assert connection.execute(text("SELECT count(*) FROM drive_bulk_shares")).scalar_one() == 0


async def test_schwab_statement_request_stays_out_of_agent_packages_with_flag_enabled(
    agent_flow, sharing
):
    created = await new_request(sharing, purpose_text="Schwab brokerage statements")
    row, private = private_request(sharing, created["requestId"])
    assert private.get("agent_package_required") is not True
    assert row["agent_package_required"] is False


async def test_allow_binds_exact_package_and_owner_cent_price_without_sending_files(
    agent_flow, request_bulk, sharing, monkeypatch
):
    created, search, ready = await prepared_package(
        agent_flow, request_bulk, sharing, count=2, selected=1
    )
    # Rollout affects only new creation. A marked request cannot downgrade to
    # metadata-only sharing when the rollout flag is subsequently disabled.
    monkeypatch.setenv("DRIVE_AGENT_PACKAGES_ENABLED", "false")
    clear_runtime_settings_caches()
    assert "packageDisclosure" not in await sharing.requester_context(
        user_id="recipient", request_id=created["requestId"]
    )
    result = await allow(sharing, created, ready)
    context = await sharing.requester_context(user_id="recipient", request_id=created["requestId"])
    disclosure = context["packageDisclosure"]
    assert disclosure["selectedCount"] == 1
    assert disclosure["coverageStatus"] == "unknown"  # no cited periods in fixture
    assert disclosure["limitations"] and disclosure["periods"] == []
    assert "Unrelated old record" not in str(disclosure)
    assert disclosure["packageDigest"] == ready["digest"]
    assert result["ownerAllowed"] is True and result["amountCents"] == 125
    row, private = private_request(sharing, created["requestId"])
    marker = package_allow_marker(private)
    assert marker["package_digest"] == ready["digest"]
    assert marker["package_revision"] == ready["revision"]
    assert marker["selected_positions"] == [1]
    assert marker["search_job_id"] == search
    assert marker["selected_sources"][0]["source_version"] == "7"
    assert row["quoted_amount_cents"] == 125
    assert (await allow(sharing, created, ready))["ownerAllowed"] is True
    with pytest.raises(DriveSharingError):
        await allow(sharing, created, ready, amount_cents=126)
    with sharing.db.engine.begin() as connection:
        assert not request_requires_owner_review(
            connection,
            user_id="owner",
            request_id=created["requestId"],
            revision=created["revision"],
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
    "mutation",
    [
        "missing_digest",
        "wrong_digest",
        "wrong_package_revision",
        "request_revision",
        "connection_generation",
        "background_off",
        "disconnected",
    ],
)
async def test_allow_rejects_stale_or_unapproved_package(
    agent_flow, request_bulk, sharing, mutation
):
    created, _, ready = await prepared_package(
        agent_flow, request_bulk, sharing, count=1, selected=1
    )
    kwargs = {}
    if mutation == "missing_digest":
        kwargs["package_digest"] = None
    elif mutation == "wrong_digest":
        kwargs["package_digest"] = "0" * 64
    elif mutation == "wrong_package_revision":
        kwargs["package_revision"] = ready["revision"] + 1
    else:
        sql = {
            "request_revision": "UPDATE drive_share_requests SET revision=revision+1 WHERE request_id=:request",
            "connection_generation": "UPDATE user_external_connector_connections SET connection_generation=connection_generation+1 WHERE user_id='owner'",
            "background_off": "INSERT INTO drive_live_preferences(user_id,connection_generation,background_enabled) VALUES('owner',1,FALSE)",
            "disconnected": "UPDATE connections SET status='disconnected' WHERE user_a_id='owner' AND user_b_id='recipient'",
        }[mutation]
        with sharing.db.engine.begin() as connection:
            connection.execute(text(sql), {"request": created["requestId"]})
    with pytest.raises(DriveReadError):
        await allow(sharing, created, ready, **kwargs)
    row, private = private_request(sharing, created["requestId"])
    assert row["owner_allowed_at"] is None and package_allow_marker(private) is None


async def test_manual_bulk_route_cannot_replace_the_agent_selection(
    agent_flow, request_bulk, sharing
):
    created, search, ready = await prepared_package(
        agent_flow, request_bulk, sharing, count=2, selected=1
    )
    # Adding a peer to Trusted must not promote an unapproved package into an
    # automatic grant. Its own sealed package approval remains required.
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO one_location_circle_memberships
              SELECT id,'recipient','active' FROM one_location_circles
              WHERE owner_user_id='owner' AND system_kind='trusted'""")
        )

    async def freeze(positions):
        return await request_bulk.create_review(
            user_id="owner",
            search_job_id=search,
            client_request_id=str(uuid4()),
            recipients=[_recipient("recipient", "b@example.invalid")],
            excluded=[],
            origin_request_id=created["requestId"],
            selected_positions=positions,
        )

    with pytest.raises(DriveReadError):
        await freeze([1])
    await allow(sharing, created, ready)
    with pytest.raises(DriveReadError):
        await freeze([2])
    frozen = await freeze([1])
    assert frozen["positions"] == [1]
    with pytest.raises(DriveReadError):
        await request_bulk.approve(
            user_id="owner",
            share_id=frozen["shareId"],
            revision=frozen["revision"],
            review_digest=frozen["reviewDigest"],
            approval_source="owner",
        )


async def test_46_evaluated_candidates_freeze_only_30_selected_before_checkout(
    agent_flow, request_bulk, sharing, monkeypatch
):
    created, _, ready = await prepared_package(agent_flow, request_bulk, sharing)
    await allow(sharing, created, ready)
    real_service = DriveRequestBulkService

    def request_service(**kwargs):
        return real_service(
            **kwargs,
            search=DriveOwnerSearchService(store=DriveOwnerSearchStore(db=sharing.db)),
            recipient_identity=AsyncMock(return_value=recipient()),
        )

    monkeypatch.setattr(automatic_module, "DriveRequestBulkService", request_service)

    async def payment_ready(**kwargs):
        assert kwargs["request_id"] == created["requestId"]
        with sharing.db.engine.begin() as connection:
            positions = (
                connection.execute(
                    text(
                        "SELECT source_position FROM drive_bulk_share_files WHERE origin_request_id=:request ORDER BY source_position"
                    ),
                    {"request": created["requestId"]},
                )
                .scalars()
                .all()
            )
            assert positions == list(range(1, 31))
            assert (
                connection.execute(
                    text("SELECT count(*) FROM drive_bulk_share_effects")
                ).scalar_one()
                == 0
            )
        return {"status": "awaiting_payment"}

    payment = SimpleNamespace(
        ensure_payment_for_frozen_batch=AsyncMock(side_effect=payment_ready),
        payment_state=AsyncMock(return_value={"status": "awaiting_payment"}),
    )
    service = DriveTrustedAutoService(
        sharing=sharing, bulk=request_bulk, payment=payment, wake=AsyncMock()
    )
    # This real database test isolates package freeze ordering from external
    # Drive I/O; it does not prove the provider's current versions.
    service.preflight_package = AsyncMock()
    assert await service.share_available(user_id="owner", request_id=created["requestId"]) == 0
    payment.ensure_payment_for_frozen_batch.assert_awaited_once()
    with sharing.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_bulk_shares WHERE origin_request_id=:request"),
                {"request": created["requestId"]},
            ).scalar_one()
            == 2
        )
