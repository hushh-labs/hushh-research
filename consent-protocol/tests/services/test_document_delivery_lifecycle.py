"""Real SQL/HTTP copy lifecycle. Provider and object transport alone are synthetic."""

# ruff: noqa: F811 -- shared isolated PostgreSQL fixtures

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import (
    DeliveryError,
    Prepare,
    Revoke,
    Upload,
    key_fingerprint,
)
from hushh_mcp.services.document_delivery.store import delivery_summary, iso
from tests.helpers.document_delivery_client import (
    b64,
    new_request,
    pay,
    prove_key,
    signed_payment_callback,
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


@pytest.mark.asyncio
async def test_missing_stripe_configuration_refuses_readiness_and_intake(
    delivery_system, delivery_app, monkeypatch
):
    monkeypatch.delenv("STRIPE_SECRET_KEY")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=delivery_app), base_url="https://one.invalid"
    ) as client:
        response = await client.get(
            "/api/connectors/google_drive/sharing/delivery-readiness",
            headers={"Authorization": "recipient"},
        )
    assert response.status_code == 200
    assert response.json()["enabled"] is False
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=delivery_app), base_url="https://one.invalid"
    ) as client:
        refused = await client.post(
            "/api/connectors/google_drive/sharing/delivery-requests",
            headers={"Authorization": "recipient"},
            json={
                "version": 1,
                "ownerUserId": "owner",
                "clientRequestId": str(uuid4()),
                "purpose": {"purpose": "Statements", "periodStart": None, "periodEnd": None},
                "receiveThrough": "one",
                "activityDisclosureVersion": "one-document-activity-v1",
                "activityAccepted": True,
                "recipientKeyId": "key-test",
                "recipientKeyFingerprint": key_fingerprint(delivery_system.public),
            },
        )
    assert refused.status_code == 503
    assert refused.json()["detail"]["code"] == "delivery_unavailable"
    with pytest.raises(DeliveryError, match="delivery_unavailable") as error:
        await delivery_system.service.create(requester="recipient", owner="owner", body={})
    assert error.value.status == 503


@pytest.mark.asyncio
async def test_delivery_worker_rotates_held_contracts_before_next_bounded_sweep(delivery_system):
    from hushh_mcp.services.document_delivery.lifecycle import DocumentDeliveryWorker
    from tests.services.test_drive_request_payment import _checkout_sdk_response

    system = delivery_system
    system.provider.checkout.Session.create.side_effect = lambda **kw: _checkout_sdk_response(
        kw, "cs_test_" + uuid4().hex
    )
    requests = []
    for mode in ("both", "both", "both", "one"):
        request_id = (await new_request(system, mode=mode))["requestId"]
        staged = await stage(system, request_id)
        await prove_key(system, request_id)
        await system.payment.checkout(
            requester_user_id="recipient",
            request_id=request_id,
            accepted_contract={
                "acceptedTermsRevision": 1,
                "acceptedTermsDigest": staged.package["termsDigest"],
                "acceptedPackageDigest": staged.package["packageDigest"],
            },
        )
        await signed_payment_callback(system, request_id, payment_intent="pi_test_" + uuid4().hex)
        requests.append(request_id)
    with system.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE document_delivery_contracts SET updated_at=clock_timestamp()-INTERVAL '1 day' WHERE receive_through='both'"
            )
        )
    worker = DocumentDeliveryWorker(service=system.service)
    await worker.run(max_jobs=2)
    await worker.run(max_jobs=2)
    with system.db.engine.connect() as connection:
        assert delivery_summary(connection, requests[-1]) == {
            "expected": 1,
            "confirmed": 1,
            "unsettled": 0,
        }
        assert all(delivery_summary(connection, item)["confirmed"] == 0 for item in requests[:-1])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "actor,permanent", [("owner", True), ("recipient", True), ("recipient", False)]
)
async def test_account_erasure_retains_disclosure_counts_and_private_cleanup(
    delivery_system, actor, permanent
):
    from hushh_mcp.services.account_service import AccountService

    system = delivery_system
    request_id = (await new_request(system))["requestId"]
    staged = await stage(system, request_id)
    await pay(system, request_id, staged.package)
    await system.store.release(request_id=request_id, actor="recipient")
    with system.db.engine.begin() as connection:
        AccountService._clear_external_connector_data(
            connection,
            actor,
            {},
            permanent=permanent,
        )
        assert (
            connection.execute(
                text("SELECT COUNT(*) FROM document_delivery_public_keys WHERE user_id=:user"),
                {"user": actor},
            ).scalar()
            == 0
        )
        assert delivery_summary(connection, request_id) == {
            "expected": 1,
            "confirmed": 1,
            "unsettled": 0,
        }
        assert (
            connection.execute(
                text("SELECT delivery_confirmed_at_erasure FROM drive_request_payment_obligations")
            ).scalar()
            is True
        )
        assert (
            connection.execute(text("SELECT COUNT(*) FROM document_delivery_contracts")).scalar()
            == 0
        )
        assert (
            connection.execute(
                text("SELECT COUNT(*) FROM document_delivery_cleanup WHERE status<>'removed'")
            ).scalar()
            == 3
        )
    await system.service.cleanup()
    assert system.service.objects.objects == {}


@pytest.mark.asyncio
async def test_unknown_upload_is_not_erased_from_a_missing_or_nonterminal_session(
    delivery_system, monkeypatch
):
    system = delivery_system
    request_id = (await new_request(system))["requestId"]
    projection = await system.store.source_selection(request_id=request_id, actor="owner")
    await system.store.approve(
        request_id=request_id,
        actor="owner",
        body=Prepare.model_validate(
            {
                "phase": "prepare",
                "expectedRevision": 0,
                "idempotencyKey": str(uuid4()),
                "selectedFiles": projection["files"],
                "copyDisclosureVersion": "one-document-copy-v1",
                "copyAccepted": True,
                "amountCents": 2500,
                "accessExpiresAt": "2026-10-26T00:00:00.123Z"
                if datetime.now(UTC) < datetime(2026, 10, 26, tzinfo=UTC)
                else iso(datetime.now(UTC) + timedelta(days=1)),
            }
        ),
    )
    ciphertext = secrets.token_bytes(64)
    descriptor = {
        "artifactId": str(uuid4()),
        "fileRef": projection["files"][0]["fileRef"],
        "role": "original",
        "iv": b64(secrets.token_bytes(12)),
        "plaintextBytes": 48,
        "ciphertextBytes": 64,
        "ciphertextSha256": hashlib.sha256(ciphertext).hexdigest(),
    }
    upload = await system.service.reserve_upload(
        request_id=request_id,
        actor="owner",
        body=Upload.model_validate(
            {"expectedRevision": 1, "idempotencyKey": str(uuid4()), "descriptor": descriptor}
        ),
    )
    original_send = system.service.objects.send

    async def unknown(*args):
        await original_send(*args)
        raise TimeoutError

    monkeypatch.setattr(system.service.objects, "send", unknown)
    with pytest.raises(TimeoutError):
        await system.service.upload(
            request_id=request_id,
            actor="owner",
            upload_id=upload["uploadId"],
            ciphertext=ciphertext,
        )
    await system.store.revoke(
        request_id=request_id,
        actor="owner",
        body=Revoke.model_validate(
            {"expectedRevision": 1, "idempotencyKey": str(uuid4()), "scope": "one"}
        ),
    )
    terminal = AsyncMock(return_value=False)
    monkeypatch.setattr(system.service.objects, "session_terminal", terminal)
    await system.service.cleanup()
    assert system.service.objects.objects
    with system.db.engine.begin() as connection:
        assert (
            connection.execute(text("SELECT status FROM document_delivery_cleanup")).scalar()
            == "unknown"
        )
        connection.execute(
            text("UPDATE document_delivery_cleanup SET next_attempt_at=clock_timestamp()")
        )
    terminal.return_value = True
    await system.service.cleanup()
    assert system.service.objects.objects == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("environment", ["uat", "production"])
async def test_global_flag_is_independent_of_named_legacy_cohorts_and_untrusted_headers(
    delivery_system, delivery_app, monkeypatch, environment
):
    system = delivery_system
    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", environment)
    monkeypatch.setenv("STRIPE_MODE", "live" if environment == "production" else "test")
    monkeypatch.setenv(
        "STRIPE_SECRET_KEY",
        f"sk_{'live' if environment == 'production' else 'test'}_only_synthetic_delivery",
    )
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "somebody-else")
    monkeypatch.setenv("CONNECTOR_PRODUCTION_OWNER_COHORT", "somebody-else")
    monkeypatch.setenv("PROTECTED_DOCUMENT_DELIVERY_ENABLED", "false")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=delivery_app), base_url="https://one.invalid"
    ) as client:
        response = await client.get(
            "/api/connectors/google_drive/sharing/delivery-readiness",
            headers={
                "Authorization": "recipient",
                "X-Feature-Flags": "protected_document_delivery=true",
                "baggage": "protected_document_delivery=true",
            },
        )
        assert response.json()["enabled"] is False
        monkeypatch.setenv("PROTECTED_DOCUMENT_DELIVERY_ENABLED", "true")
        assert (
            await client.get(
                "/api/connectors/google_drive/sharing/delivery-readiness",
                headers={"Authorization": "recipient"},
            )
        ).json()["enabled"] is True
    created = await new_request(system)
    assert created["delivery"]["status"] == "requested"
