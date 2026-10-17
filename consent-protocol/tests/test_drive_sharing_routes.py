"""Real route admission with synthetic identity/service boundaries."""

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth_read_only, require_vault_owner_token
from api.routes import drive_request_requester as requester_routes
from api.routes import drive_sharing as routes
from hushh_mcp.services.drive_sharing_contract import DriveSharingError

BASE = "/api/connectors/google_drive/sharing/requests"
# Fixed, not uuid4(): it is baked into parametrize ids, and pytest-xdist
# refuses to run when workers collect different ids (scripts/run-test-ci.sh).
REQUEST_ID = "5d0c7a4e-2f61-4c3b-9a8e-0d51a7e3b001"


def test_packet_catalog_requires_owner_and_validated_listing_consent(setup, monkeypatch):
    monkeypatch.setenv("DRIVE_AGENT_PACKAGES_ENABLED", "true")
    client, app, _, current = setup
    service = SimpleNamespace(
        list_packets=AsyncMock(return_value={"packets": [], "nextCursor": None}),
        set_listing=AsyncMock(return_value={"revision": 1}),
    )
    monkeypatch.setattr(routes, "_packet_service", lambda: service)
    path = "/api/connectors/google_drive/sharing/packets"
    assert client.get(path).status_code == 401
    assert not service.list_packets.called
    unlock(app)
    response = client.get(path)
    assert response.status_code == 200 and "no-store" in response.headers["Cache-Control"]
    service.list_packets.assert_awaited_once_with(
        user_id="recipient", owner_user_id=None, cursor=None
    )
    body = {
        "version": 1,
        "decision": "allow",
        "priceCents": 51,
        "expectedRevision": 0,
        "disclosure": "drive-packet-listing-connections-v1",
    }
    assert client.post(path + f"/{REQUEST_ID}/listing", json=body).status_code == 200
    service.set_listing.assert_awaited_once_with(
        user_id="recipient",
        packet_id=REQUEST_ID,
        version=1,
        decision="allow",
        price_cents=51,
        expected_revision=0,
        disclosure="drive-packet-listing-connections-v1",
    )
    for patch in (
        {"version": True},
        {"priceCents": 49},
        {"priceCents": 50001},
        {"disclosure": "background-sync"},
        {"ownerUserId": "other"},
    ):
        assert client.post(path + f"/{REQUEST_ID}/listing", json=body | patch).status_code == 422
    assert service.set_listing.await_count == 1
    current.side_effect = HTTPException(401, "Expired")
    assert client.get(path).status_code == 401
    assert service.list_packets.await_count == 1


def test_packet_request_binds_verified_recipient_and_rejects_injected_members(setup, monkeypatch):
    monkeypatch.setenv("DRIVE_AGENT_PACKAGES_ENABLED", "true")
    client, app, _, _ = setup
    service = SimpleNamespace(
        request_packet=AsyncMock(return_value={"requestId": REQUEST_ID, "existingAccess": False})
    )
    monkeypatch.setattr(routes, "_packet_service", lambda: service)
    unlock(app)
    identity = SimpleNamespace(user_id="recipient")
    app.dependency_overrides[routes._recipient] = lambda: identity
    path = f"/api/connectors/google_drive/sharing/packets/{REQUEST_ID}/requests"
    body = {"version": 2, "clientRequestId": REQUEST_ID}
    assert client.post(path, json=body).status_code == 202
    service.request_packet.assert_awaited_once_with(
        user_id="recipient",
        recipient=identity,
        packet_id=REQUEST_ID,
        version=2,
        client_request_id=REQUEST_ID,
    )
    for patch in ({"sourceIds": ["private"]}, {"priceCents": 50}, {"version": "2"}):
        assert client.post(path, json=body | patch).status_code == 422
    assert service.request_packet.await_count == 1


def test_packet_mutations_stop_when_new_packages_are_disabled(setup, monkeypatch):
    monkeypatch.setenv("DRIVE_AGENT_PACKAGES_ENABLED", "false")
    client, app, _, _ = setup
    service = SimpleNamespace(
        set_listing=AsyncMock(),
        request_packet=AsyncMock(),
    )
    monkeypatch.setattr(routes, "_packet_service", lambda: service)
    unlock(app)
    app.dependency_overrides[routes._recipient] = lambda: SimpleNamespace(user_id="recipient")
    path = f"/api/connectors/google_drive/sharing/packets/{REQUEST_ID}"
    listing = {
        "version": 1,
        "decision": "allow",
        "priceCents": 100,
        "expectedRevision": 0,
        "disclosure": "drive-packet-listing-connections-v1",
    }
    assert client.post(path + "/listing", json=listing).status_code == 404
    assert (
        client.post(
            path + "/requests", json={"version": 1, "clientRequestId": REQUEST_ID}
        ).status_code
        == 404
    )
    service.set_listing.assert_not_called()
    service.request_packet.assert_not_called()
    service.set_listing.return_value = {"revision": 2}
    assert client.post(path + "/listing", json={**listing, "decision": "deny"}).status_code == 200
    service.set_listing.assert_awaited_once()


@pytest.fixture
def setup(monkeypatch):
    app = FastAPI()
    app.include_router(routes.router)
    service = SimpleNamespace(
        **{
            name: AsyncMock(return_value={"status": "pending"})
            for name in (
                "create",
                "list_requests",
                "status",
                "requester_context",
                "review",
                "delivery",
                "approve",
                "allow",
                "set_request_price",
                "decide",
                "retry_preparation",
                "prepare_revocation",
                "revoke",
                "owner_pricing",
                "update_owner_pricing",
                "request_quote",
            )
        }
    )
    monkeypatch.setattr(routes, "_service", lambda: service)
    current = AsyncMock(return_value={"user_id": "recipient"})
    # FastAPI retains the original dependency; this replaces only the fresh
    # post-await revalidation call, not the initial route admission.
    monkeypatch.setattr(routes, "require_vault_owner_token", current)
    return TestClient(app), app, service, current


def unlock(app, uid="recipient"):
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": uid,
        "token": "synthetic-owner",
    }


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("get", "/pricing", None),
        ("put", "/pricing", {"enabled": True, "amountCents": 2500, "expectedVersion": 0}),
        ("get", f"/quote?ownerPersonRef={REQUEST_ID}", None),
    ],
)
def test_pricing_routes_require_owner(setup, method, path, body):
    client, _, service, _ = setup
    response = client.request(method, "/api/connectors/google_drive/sharing" + path, json=body)
    assert response.status_code == 401
    assert "no-store" in response.headers["Cache-Control"]
    assert all(not value.called for value in vars(service).values())


def test_pricing_routes_bind_authenticated_owner_and_validate_price(setup, monkeypatch):
    client, app, service, _ = setup
    unlock(app)
    base = "/api/connectors/google_drive/sharing"
    service.owner_pricing.return_value = {"enabled": False, "amountCents": 1000, "version": 0}
    response = client.get(base + "/pricing")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    service.owner_pricing.assert_awaited_once_with(user_id="recipient")

    response = client.put(
        base + "/pricing",
        json={
            "enabled": True,
            "amountCents": 2500,
            "expectedVersion": 0,
        },
    )
    assert response.status_code == 200
    service.update_owner_pricing.assert_awaited_once_with(
        user_id="recipient", enabled=True, amount_cents=2500, expected_version=0
    )
    for invalid in (49, 0, 50001, True):
        response = client.put(
            base + "/pricing",
            json={
                "enabled": True,
                "amountCents": invalid,
                "expectedVersion": 0,
            },
        )
        assert response.status_code == 422
    assert service.update_owner_pricing.await_count == 1

    monkeypatch.setattr(routes, "_person_target", AsyncMock(return_value="owner"))
    service.request_quote.return_value = {
        "amountCents": 2500,
        "version": 1,
        "paymentRequired": True,
        "payoutReady": False,
    }
    response = client.get(base + f"/quote?ownerPersonRef={REQUEST_ID}")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    service.request_quote.assert_awaited_once_with(user_id="recipient", owner_user_id="owner")


@pytest.mark.parametrize(
    "method,suffix,body",
    [
        ("get", "", None),
        ("get", f"/{REQUEST_ID}", None),
        ("get", f"/{REQUEST_ID}/review", None),
        ("get", f"/{REQUEST_ID}/context", None),
        ("get", f"/{REQUEST_ID}/delivery", None),
        ("post", f"/{REQUEST_ID}/prepare", {}),
        ("post", f"/{REQUEST_ID}/prepare/stream", {}),
        (
            "post",
            "",
            {
                "ownerUserId": "owner",
                "clientRequestId": str(uuid4()),
                "purpose": {
                    "purpose": "Statements",
                    "periodStart": "2026-09-01",
                    "periodEnd": "2026-09-30",
                },
            },
        ),
        (
            "post",
            f"/{REQUEST_ID}/approve",
            {
                "revision": 1,
                "reviewDigest": "a" * 64,
                "documentIds": [str(uuid4())],
                "confirmed": True,
            },
        ),
        ("post", f"/{REQUEST_ID}/allow", {"revision": 0, "confirmed": True}),
        (
            "post",
            f"/{REQUEST_ID}/price",
            {"revision": 0, "amountCents": 1000, "confirmed": True},
        ),
        ("post", f"/{REQUEST_ID}/decline", {"revision": 0}),
        ("post", f"/{REQUEST_ID}/cancel", {"revision": 0}),
        ("post", f"/{REQUEST_ID}/review/refresh", {"revision": 0}),
        ("post", f"/{REQUEST_ID}/revocation/prepare", None),
        (
            "post",
            f"/{REQUEST_ID}/revocation/confirm",
            {
                "revision": 1,
                "directiveId": "synthetic-directive",
                "reviewDigest": "a" * 64,
                "grantIds": [str(uuid4())],
                "confirmed": True,
            },
        ),
    ],
)
def test_every_route_requires_owner(setup, method, suffix, body):
    client, _, service, _ = setup
    response = client.request(method, BASE + suffix, json=body)
    assert response.status_code == 401
    assert "no-store" in response.headers["Cache-Control"]
    assert all(not value.called for value in vars(service).values())


def test_review_is_owner_derived_no_store_and_authority_rechecked(setup):
    client, app, service, current = setup
    unlock(app)
    service.review.return_value = {"files": [{"name": "private-name"}]}
    response = client.get(BASE + f"/{REQUEST_ID}/review")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    service.review.assert_awaited_once_with(user_id="recipient", request_id=REQUEST_ID)
    assert current.await_count == 2
    assert all(
        call.kwargs == {"authorization": "Bearer synthetic-owner", "hushh_consent": None}
        for call in current.await_args_list
    )


def test_requester_context_is_private_and_rechecks_vault_authority(setup):
    client, app, service, current = setup
    unlock(app)
    service.requester_context.return_value = {
        "requestId": REQUEST_ID,
        "purpose": {"purpose": "Private request", "periodStart": None, "periodEnd": None},
    }
    response = client.get(BASE + f"/{REQUEST_ID}/context")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    service.requester_context.assert_awaited_once_with(user_id="recipient", request_id=REQUEST_ID)
    assert current.await_count == 2

    current.side_effect = [{"user_id": "recipient"}, HTTPException(401, "Owner revoked")]
    response = client.get(BASE + f"/{REQUEST_ID}/context")
    assert response.status_code == 401
    assert "Private request" not in response.text
    assert "no-store" in response.headers["Cache-Control"]

    current.side_effect = None
    service.requester_context.side_effect = DriveSharingError("request_unavailable")
    response = client.get(BASE + f"/{REQUEST_ID}/context")
    assert response.status_code == 404
    assert "no-store" in response.headers["Cache-Control"]


def test_delivery_details_ask_for_the_price_recovery_and_review_views(setup):
    # Only GET /delivery adds the requester's price and recovery (or the owner's
    # review notice); file pages read the bare snapshot.
    client, app, service, _ = setup
    unlock(app)
    service.delivery.return_value = {"requestId": REQUEST_ID, "status": "partial", "files": []}
    response = client.get(BASE + f"/{REQUEST_ID}/delivery")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    service.delivery.assert_awaited_once_with(
        user_id="recipient", request_id=REQUEST_ID, views=True
    )


def test_late_owner_revocation_releases_no_private_result(setup):
    client, app, service, current = setup
    unlock(app)
    service.review.return_value = {"files": [{"name": "private-name"}]}
    current.side_effect = [{"user_id": "recipient"}, HTTPException(401, "Owner revoked")]
    response = client.get(BASE + f"/{REQUEST_ID}/review")
    assert response.status_code == 401 and "private-name" not in response.text
    assert "no-store" in response.headers["Cache-Control"]


@pytest.mark.parametrize(
    "change",
    [
        {"email": "injected@example.invalid"},
        {"role": "owner"},
        {"generation": 9},
        {"user_id": "other"},
        {"confirmed": 1},
        {"confirmed": "true"},
    ],
)
def test_approval_does_not_accept_client_authority(setup, change):
    client, app, service, _ = setup
    unlock(app)
    body = {
        "revision": 1,
        "reviewDigest": "a" * 64,
        "documentIds": [str(uuid4())],
        "confirmed": True,
    }
    response = client.post(BASE + f"/{REQUEST_ID}/approve", json={**body, **change})
    assert response.status_code == 422
    assert "no-store" in response.headers["Cache-Control"]
    service.approve.assert_not_called()


def test_validation_never_echoes_private_payload(setup):
    client, app, _, _ = setup
    unlock(app)
    response = client.post(
        BASE + f"/{REQUEST_ID}/approve",
        json={
            "revision": "private-value-accidentally-pasted",
            "reviewDigest": "a" * 64,
            "documentIds": [str(uuid4())],
            "confirmed": True,
        },
    )
    assert response.status_code == 422
    assert "private-value-accidentally-pasted" not in response.text


def test_approval_only_acknowledges_pending_work(setup):
    client, app, service, _ = setup
    unlock(app)
    service.approve.return_value = {"status": "approved", "sharingStatus": "pending"}
    response = client.post(
        BASE + f"/{REQUEST_ID}/approve",
        json={
            "revision": 1,
            "reviewDigest": "a" * 64,
            "documentIds": [str(uuid4())],
            "confirmed": True,
        },
    )
    assert response.status_code == 202
    assert response.json() == {"status": "approved", "sharingStatus": "pending"}


def test_withdraw_refuses_paid_requests_and_never_fails_on_checkout_retirement(setup, monkeypatch):
    from hushh_mcp.services import drive_request_payment_service as payments

    client, app, service, _ = setup
    unlock(app)
    service.decide.side_effect = DriveSharingError("request_paid")
    for action in ("cancel", "decline"):
        response = client.post(BASE + f"/{REQUEST_ID}/{action}", json={"revision": 0})
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "request_paid"
        assert "no-store" in response.headers["Cache-Control"]

    service.decide.side_effect = None
    payment = {"state": "closed", "amountCents": 2500, "refund": None, "nextAction": "none"}
    service.decide.return_value = {
        "requestId": REQUEST_ID,
        "status": "cancelled",
        "revision": 0,
        "payment": payment,
    }
    retire = AsyncMock(side_effect=RuntimeError("stripe-secret-error"))
    monkeypatch.setattr(
        payments, "DriveRequestPaymentService", lambda: SimpleNamespace(retire_checkout=retire)
    )
    response = client.post(BASE + f"/{REQUEST_ID}/cancel", json={"revision": 0})
    assert response.status_code == 200 and response.json()["payment"] == payment
    assert "stripe-secret-error" not in response.text
    retire.assert_awaited_once_with(requester_user_id="recipient", request_id=REQUEST_ID)

    # Payment won the race at Stripe: the withdrawal reports the refund it will get.
    retire.side_effect, retire.return_value = None, "paid"
    response = client.post(BASE + f"/{REQUEST_ID}/cancel", json={"revision": 0})
    assert response.status_code == 200
    assert response.json()["payment"]["state"] == "refund_pending"
    assert response.json()["payment"]["refund"] == {"status": "queued", "amountCents": 2500}


@pytest.mark.parametrize(
    "body",
    [
        {"revision": 0},
        {"revision": 0, "confirmed": False},
        {"revision": 0, "confirmed": 1},
        {"revision": 0, "confirmed": "true"},
        {"revision": 0, "confirmed": True, "amountCents": 0},
        {"revision": 0, "confirmed": True, "amountCents": 49},
        {"revision": 0, "confirmed": True, "amountCents": 50100},
        {"revision": 0, "confirmed": True, "amountCents": 2000.0},
        {"revision": 0, "confirmed": True, "amountCents": "2000"},
        {"revision": 0, "confirmed": True, "amountCents": True},
        {"revision": 0, "confirmed": True, "trustedAuto": True},
    ],
)
def test_allow_needs_explicit_confirmation_and_integer_cent_price(setup, body):
    client, app, service, _ = setup
    unlock(app)
    response = client.post(BASE + f"/{REQUEST_ID}/allow", json=body)
    assert response.status_code == 422
    assert "no-store" in response.headers["Cache-Control"]
    service.allow.assert_not_called()


@pytest.mark.parametrize("amount", [50, 51, 99, 100, 1234, 49999, 50000])
def test_allow_keeps_owner_cent_amount_without_rounding(setup, amount):
    client, app, service, _ = setup
    unlock(app)
    response = client.post(
        BASE + f"/{REQUEST_ID}/allow",
        json={"revision": 3, "confirmed": True, "amountCents": amount},
    )
    assert response.status_code == 202
    assert service.allow.await_args.kwargs["amount_cents"] == amount


def test_allow_forwards_the_owners_price_and_reports_refusals(setup):
    client, app, service, current = setup
    unlock(app)
    service.allow.return_value = {
        "requestId": REQUEST_ID,
        "status": "pending",
        "revision": 3,
        "ownerAllowed": True,
        "amountCents": 2000,
    }
    response = client.post(
        BASE + f"/{REQUEST_ID}/allow",
        json={"revision": 3, "amountCents": 2000, "confirmed": True},
    )
    assert response.status_code == 202
    assert response.json() == service.allow.return_value
    service.allow.assert_awaited_once_with(
        user_id="recipient", request_id=REQUEST_ID, revision=3, amount_cents=2000
    )
    assert current.await_count == 2

    response = client.post(BASE + f"/{REQUEST_ID}/allow", json={"revision": 3, "confirmed": True})
    assert response.status_code == 202
    assert service.allow.await_args.kwargs["amount_cents"] is None

    for code, status in (("invalid_payment_amount", 422), ("request_already_decided", 409)):
        service.allow.side_effect = DriveSharingError(code)
        response = client.post(
            BASE + f"/{REQUEST_ID}/allow", json={"revision": 3, "confirmed": True}
        )
        assert response.status_code == status
        assert response.json()["detail"]["code"] == code
        assert "no-store" in response.headers["Cache-Control"]


@pytest.mark.parametrize("amount", [None, 0, 49, 50001, 2000.0, "2000", True])
def test_trusted_price_rejects_missing_or_invalid_amount(setup, amount):
    client, app, service, _ = setup
    unlock(app)
    response = client.post(
        BASE + f"/{REQUEST_ID}/price",
        json={"revision": 0, "amountCents": amount, "confirmed": True},
    )
    assert response.status_code == 422
    assert "no-store" in response.headers["Cache-Control"]
    service.set_request_price.assert_not_called()


def test_trusted_price_requires_confirmation_and_binds_authenticated_owner(setup):
    client, app, service, current = setup
    unlock(app)
    for confirmed in (False, "true", 1):
        assert (
            client.post(
                BASE + f"/{REQUEST_ID}/price",
                json={"revision": 3, "amountCents": 2000, "confirmed": confirmed},
            ).status_code
            == 422
        )
    service.set_request_price.assert_not_called()
    response = client.post(
        BASE + f"/{REQUEST_ID}/price",
        json={"revision": 3, "amountCents": 2000, "confirmed": True},
    )
    assert response.status_code == 202
    service.set_request_price.assert_awaited_once_with(
        user_id="recipient", request_id=REQUEST_ID, revision=3, amount_cents=2000
    )
    service.allow.assert_not_called()
    assert current.await_count == 2


@pytest.mark.parametrize(
    "error", [RuntimeError("secret-provider-body"), DriveSharingError("secret-provider-body")]
)
def test_unknown_errors_are_redacted(setup, error):
    client, app, service, _ = setup
    unlock(app)
    service.review.side_effect = error
    response = client.get(BASE + f"/{REQUEST_ID}/review")
    assert response.status_code == 503 and "secret-provider-body" not in response.text
    assert "no-store" in response.headers["Cache-Control"]


def google_identity(monkeypatch, app, *, firebase_uid="recipient", changes=None):
    app.dependency_overrides[require_firebase_auth_read_only] = lambda: firebase_uid
    claims = {
        "uid": "recipient",
        "email": "recipient@example.invalid",
        "email_verified": True,
        "auth_time": datetime.now(UTC).timestamp(),
        "firebase": {"sign_in_provider": "google.com", "identities": {"google.com": ["12345"]}},
        **(changes or {}),
    }
    app_marker = object()
    monkeypatch.setattr(routes, "get_firebase_auth_app", lambda: app_marker)
    verifier = Mock(return_value=claims)
    monkeypatch.setattr(routes.firebase_auth, "verify_id_token", verifier)
    monkeypatch.setattr(
        routes.firebase_auth,
        "get_user",
        Mock(
            return_value=SimpleNamespace(
                disabled=False,
                provider_data=[
                    SimpleNamespace(
                        provider_id="google.com", uid="12345", email="recipient@example.invalid"
                    )
                ],
            )
        ),
    )
    return verifier, app_marker


def create_body():
    return {
        "ownerUserId": "owner",
        "clientRequestId": str(uuid4()),
        "purpose": {
            "purpose": "Statements",
            "periodStart": "2026-09-01",
            "periodEnd": "2026-09-30",
        },
    }


def test_request_uses_fresh_verified_google_identity_not_drive_connection(setup, monkeypatch):
    client, app, service, _ = setup
    unlock(app)
    verifier, marker = google_identity(monkeypatch, app)
    response = client.post(
        BASE, json=create_body(), headers={"Authorization": "Bearer synthetic-firebase"}
    )
    assert response.status_code == 202
    recipient = service.create.await_args.kwargs["recipient"]
    assert recipient.user_id == "recipient" and recipient.subject == "12345"
    assert service.create.await_args.kwargs["access_days"] is None
    verifier.assert_called_once_with("synthetic-firebase", app=marker, check_revoked=False)


def test_request_freezes_valid_requester_timezone_and_rejects_unknown_zone(setup, monkeypatch):
    client, app, service, _ = setup
    unlock(app)
    google_identity(monkeypatch, app)
    body = {**create_body(), "timeZone": "Asia/Kolkata"}

    response = client.post(BASE, json=body, headers={"Authorization": "Bearer synthetic-firebase"})
    assert response.status_code == 202
    assert service.create.await_args.kwargs["request_time_zone"] == "Asia/Kolkata"

    service.create.reset_mock()
    response = client.post(
        BASE,
        json={**body, "timeZone": "Invalid/NotAZone"},
        headers={"Authorization": "Bearer synthetic-firebase"},
    )
    assert response.status_code == 422
    service.create.assert_not_awaited()


def test_verified_ria_request_is_checked_server_side_and_shown_to_owner(setup, monkeypatch):
    client, app, service, _ = setup
    unlock(app)
    google_identity(monkeypatch, app)
    ria = SimpleNamespace(
        require_ria_verified=AsyncMock(return_value=None),
        get_ria_onboarding_status=AsyncMock(
            return_value={
                "exists": True,
                "display_name": "Chris",
                "individual_legal_name": "Chris Advisor",
                "individual_crd": "123456",
                "advisory_firm_legal_name": "Example Advisory",
            }
        ),
    )
    monkeypatch.setattr(routes, "RIAIAMService", lambda: ria)
    body = {
        **create_body(),
        "requesterActorType": "ria",
        "accessDays": 7,
        "reason": "Review the requested account history",
    }
    response = client.post(BASE, json=body, headers={"Authorization": "Bearer synthetic-firebase"})
    assert response.status_code == 202
    ria.require_ria_verified.assert_awaited_once_with("recipient")
    assert service.create.await_args.kwargs["requester_profile"] == {
        "type": "ria",
        "displayName": "Chris",
        "legalName": "Chris Advisor",
        "crd": "123456",
        "firmName": "Example Advisory",
    }
    assert service.create.await_args.kwargs["access_days"] == 7
    assert service.create.await_args.kwargs["reason"] == "Review the requested account history"

    service.create.reset_mock()
    ria.require_ria_verified.side_effect = routes.RIAIAMPolicyError(
        "RIA verification incomplete", status_code=403
    )
    denied = client.post(
        BASE,
        json={**body, "clientRequestId": str(uuid4())},
        headers={"Authorization": "Bearer synthetic-firebase"},
    )
    assert denied.status_code == 403
    service.create.assert_not_awaited()


def test_request_resolves_public_reference_without_accepting_identity_from_client(
    setup, monkeypatch
):
    client, app, service, current = setup
    unlock(app)
    google_identity(monkeypatch, app)
    target = str(uuid4())
    resolve = Mock(return_value=("resolved-owner", {"status": "connected"}))
    monkeypatch.setattr(
        routes, "PersonProfileService", lambda: SimpleNamespace(get_relationship_target=resolve)
    )
    body = {**create_body(), "ownerPersonRef": target}
    del body["ownerUserId"]
    response = client.post(BASE, json=body, headers={"Authorization": "Bearer synthetic-firebase"})
    assert response.status_code == 202
    resolve.assert_called_once_with(viewer_user_id="recipient", public_person_ref=target)
    assert service.create.await_args.kwargs["owner_user_id"] == "resolved-owner"
    assert "resolved-owner" not in response.text
    assert current.await_count >= 3


@pytest.mark.parametrize(
    "targets",
    [
        {},
        {"ownerUserId": "owner", "ownerPersonRef": str(uuid4())},
        {"ownerPersonRef": "private-invalid-value"},
    ],
)
def test_request_requires_exactly_one_valid_owner_target(setup, monkeypatch, targets):
    client, app, service, _ = setup
    unlock(app)
    google_identity(monkeypatch, app)
    body = create_body()
    del body["ownerUserId"]
    response = client.post(
        BASE, json={**body, **targets}, headers={"Authorization": "Bearer synthetic-firebase"}
    )
    assert response.status_code == 422
    assert "private-invalid-value" not in response.text
    service.create.assert_not_called()


@pytest.mark.parametrize(
    "failure",
    [routes.PersonProfileNotFoundError("missing"), TimeoutError("private-provider-error")],
)
def test_owner_reference_failure_is_redacted_and_does_not_mutate(setup, monkeypatch, failure):
    client, app, service, _ = setup
    unlock(app)
    google_identity(monkeypatch, app)
    monkeypatch.setattr(
        routes,
        "PersonProfileService",
        lambda: SimpleNamespace(get_relationship_target=Mock(side_effect=failure)),
    )
    body = create_body()
    del body["ownerUserId"]
    response = client.post(
        BASE,
        json={**body, "ownerPersonRef": str(uuid4())},
        headers={"Authorization": "Bearer synthetic-firebase"},
    )
    assert response.status_code in (404, 503)
    assert "private-provider-error" not in response.text
    service.create.assert_not_called()


def test_owner_lock_during_reference_lookup_prevents_create(setup, monkeypatch):
    client, app, service, current = setup
    unlock(app)
    google_identity(monkeypatch, app)

    def resolve(**kwargs):
        current.side_effect = HTTPException(401, "Owner locked")
        return "resolved-owner", {"status": "connected"}

    monkeypatch.setattr(
        routes, "PersonProfileService", lambda: SimpleNamespace(get_relationship_target=resolve)
    )
    body = create_body()
    del body["ownerUserId"]
    response = client.post(
        BASE,
        json={**body, "ownerPersonRef": str(uuid4())},
        headers={"Authorization": "Bearer synthetic-firebase"},
    )
    assert response.status_code == 401
    service.create.assert_not_called()


def test_crossed_firebase_and_vault_owners_fail_before_provider_lookup(setup, monkeypatch):
    client, app, service, _ = setup
    unlock(app)
    verifier, _ = google_identity(monkeypatch, app, firebase_uid="attacker")
    response = client.post(
        BASE, json=create_body(), headers={"Authorization": "Bearer synthetic-firebase"}
    )
    assert response.status_code == 403
    verifier.assert_not_called()
    service.create.assert_not_called()


@pytest.mark.parametrize(
    "changes",
    [
        {"firebase": {"identities": {"google.com": ["attacker"]}}},
        {"firebase": {"sign_in_provider": "password"}},
    ],
)
def test_missing_or_substituted_linked_identity_cannot_request(setup, monkeypatch, changes):
    client, app, service, _ = setup
    unlock(app)
    google_identity(monkeypatch, app, changes=changes)
    response = client.post(
        BASE, json=create_body(), headers={"Authorization": "Bearer synthetic-firebase"}
    )
    assert response.status_code == 409
    service.create.assert_not_called()


def test_prepare_rejects_client_claimed_foreground_authority(setup):
    client, app, _, _ = setup
    unlock(app)
    response = client.post(BASE + f"/{REQUEST_ID}/prepare", json={"foreground": True})
    assert response.status_code == 422


def test_owner_search_post_retries_with_vault_identity_and_no_client_authority_mode(
    setup, monkeypatch
):
    client, app, _, current = setup
    bulk = SimpleNamespace(
        start_search=AsyncMock(return_value={"status": "queued", "jobId": "same-job"})
    )
    monkeypatch.setattr(routes, "_request_bulk_service", lambda: bulk)
    path = BASE + f"/{REQUEST_ID}/search"

    assert client.post(path, json={}).status_code == 401
    bulk.start_search.assert_not_awaited()
    unlock(app)
    response = client.post(path, json={"timeZone": "Asia/Kolkata"})
    assert response.status_code == 200
    assert response.json() == {"status": "queued", "jobId": "same-job"}
    assert response.headers["Cache-Control"] == "private, no-store"
    bulk.start_search.assert_awaited_once_with(
        user_id="recipient", request_id=REQUEST_ID, timezone="Asia/Kolkata"
    )
    assert current.await_count >= 2
    assert callable(bulk.require_owner)
    assert client.post(path, json={"authorityMode": "agent_package"}).status_code == 422
    assert bulk.start_search.await_count == 1


def test_prepare_rechecks_owner_and_sanitizes_failure(setup, monkeypatch):
    from hushh_mcp.services import drive_suggestion_service

    client, app, _, current = setup
    unlock(app)
    worker = SimpleNamespace(
        run_one=AsyncMock(side_effect=RuntimeError("private provider response"))
    )
    factory = Mock(return_value=worker)
    monkeypatch.setattr(drive_suggestion_service, "DriveSuggestionService", factory)
    response = client.post(BASE + f"/{REQUEST_ID}/prepare", json={})
    assert response.status_code == 503
    assert "private provider" not in response.text
    assert "no-store" in response.headers["Cache-Control"]
    assert current.await_count >= 1
    assert callable(factory.call_args.kwargs["require_owner"])


def sse_frames(text):
    """Parse the stream body into (event, payload) pairs."""
    import json

    frames = []
    for block in text.split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        if "event" in lines:
            frames.append((lines["event"], json.loads(lines["data"])))
    return frames


@pytest.fixture(autouse=True)
def no_stream_tasks():
    routes._PREPARE_STREAM_TASKS.clear()
    yield
    routes._PREPARE_STREAM_TASKS.clear()


def stream_worker(monkeypatch, run_one):
    from hushh_mcp.services import drive_suggestion_service

    worker = SimpleNamespace(run_one=run_one)
    factory = Mock(return_value=worker)
    monkeypatch.setattr(drive_suggestion_service, "DriveSuggestionService", factory)
    return factory


def test_prepare_stream_rejects_client_claimed_foreground_authority(setup):
    client, app, _, _ = setup
    unlock(app)
    response = client.post(BASE + f"/{REQUEST_ID}/prepare/stream", json={"foreground": True})
    assert response.status_code == 422


def test_prepare_stream_emits_public_stages_then_status(setup, monkeypatch):
    client, app, _, current = setup
    unlock(app)

    async def run_one(*, user_id, request_id, on_stage):
        assert (user_id, request_id) == ("recipient", REQUEST_ID)
        for stage in ("searching", "choosing", "checking", "checking"):
            on_stage(stage)
        return "review_ready"

    factory = stream_worker(monkeypatch, run_one)
    response = client.post(BASE + f"/{REQUEST_ID}/prepare/stream", json={})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["Cache-Control"] == "private, no-store, no-cache, no-transform"
    assert sse_frames(response.text) == [
        ("stage", {"event": "stage", "stage": "starting"}),
        ("stage", {"event": "stage", "stage": "searching"}),
        ("stage", {"event": "stage", "stage": "choosing"}),
        ("stage", {"event": "stage", "stage": "checking"}),
        ("complete", {"event": "complete", "status": "review_ready"}),
    ]
    # Before the 200 and again after the run, like POST /prepare.
    assert current.await_count == 2
    assert callable(factory.call_args.kwargs["require_owner"])


def test_prepare_stream_reports_a_worker_held_lease(setup, monkeypatch):
    client, app, _, _ = setup
    unlock(app)
    stream_worker(monkeypatch, AsyncMock(return_value="not_claimed"))
    response = client.post(BASE + f"/{REQUEST_ID}/prepare/stream", json={})
    assert sse_frames(response.text) == [
        ("stage", {"event": "stage", "stage": "starting"}),
        ("complete", {"event": "complete", "status": "not_claimed"}),
    ]


@pytest.mark.parametrize(
    "error", [RuntimeError("secret-provider-body"), DriveSharingError("secret-provider-body")]
)
def test_prepare_stream_failures_are_redacted(setup, monkeypatch, caplog, error):
    client, app, _, _ = setup
    unlock(app)
    stream_worker(monkeypatch, AsyncMock(side_effect=error))
    with caplog.at_level("DEBUG"):
        response = client.post(BASE + f"/{REQUEST_ID}/prepare/stream", json={})
    assert response.status_code == 200
    assert sse_frames(response.text)[-1] == (
        "error",
        {
            "event": "error",
            "code": "sharing_unavailable",
            "message": "Document sharing is not available yet.",
        },
    )
    assert "secret-provider-body" not in response.text
    assert "secret-provider-body" not in caplog.text


def test_prepare_stream_stale_owner_is_a_real_http_error(setup, monkeypatch):
    client, app, _, current = setup
    unlock(app)
    current.side_effect = HTTPException(401, "Owner revoked")
    factory = stream_worker(monkeypatch, AsyncMock(return_value="review_ready"))
    response = client.post(BASE + f"/{REQUEST_ID}/prepare/stream", json={})
    assert response.status_code == 401
    assert "no-store" in response.headers["Cache-Control"]
    factory.assert_not_called()


def test_prepare_stream_late_owner_revocation_ends_without_a_result(setup, monkeypatch):
    client, app, _, current = setup
    unlock(app)
    current.side_effect = [{"user_id": "recipient"}, HTTPException(401, "Owner revoked")]
    stream_worker(monkeypatch, AsyncMock(return_value="review_ready"))
    response = client.post(BASE + f"/{REQUEST_ID}/prepare/stream", json={})
    # No terminal frame: the client's next status read surfaces the real 401.
    assert sse_frames(response.text) == [("stage", {"event": "stage", "stage": "starting"})]
    assert "review_ready" not in response.text


def test_prepare_stream_refuses_work_past_the_pending_cap(setup, monkeypatch):
    client, app, _, _ = setup
    unlock(app)
    monkeypatch.setattr(routes, "PREPARE_STREAM_MAX_PENDING", 0)
    factory = stream_worker(monkeypatch, AsyncMock(return_value="review_ready"))
    response = client.post(BASE + f"/{REQUEST_ID}/prepare/stream", json={})
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "sharing_unavailable"
    assert "no-store" in response.headers["Cache-Control"]
    factory.assert_not_called()


class _Disconnecting:
    def __init__(self, after):
        self.checks = 0
        self.after = after

    async def is_disconnected(self):
        self.checks += 1
        return self.checks > self.after


async def test_prepare_stream_disconnect_never_cancels_the_preparation(monkeypatch):
    import asyncio

    release = asyncio.Event()
    finished = []

    async def run_one(*, user_id, request_id, on_stage):
        await release.wait()
        finished.append(request_id)
        return "review_ready"

    stream_worker(monkeypatch, run_one)
    owner = routes.Owner("recipient", "synthetic-owner")
    monkeypatch.setattr(owner.__class__, "require_current", AsyncMock())
    stream = routes._prepare_stream(
        request=_Disconnecting(after=0), owner=owner, request_id=REQUEST_ID
    )
    assert b"starting" in await anext(stream)
    with pytest.raises(StopAsyncIteration):
        await anext(stream)
    await stream.aclose()
    pending = list(routes._PREPARE_STREAM_TASKS)
    assert len(pending) == 1 and not pending[0].done()
    release.set()
    await asyncio.gather(*pending)
    assert finished == [REQUEST_ID]
    assert not routes._PREPARE_STREAM_TASKS


async def test_prepare_stream_deadline_closes_without_a_terminal_frame(monkeypatch):
    import asyncio

    release = asyncio.Event()

    async def run_one(*, user_id, request_id, on_stage):
        await release.wait()
        return "review_ready"

    stream_worker(monkeypatch, run_one)
    monkeypatch.setattr(routes, "PREPARE_STREAM_DEADLINE_SECONDS", 0.05)
    monkeypatch.setattr(routes, "PREPARE_STREAM_HEARTBEAT_SECONDS", 0.01)
    owner = routes.Owner("recipient", "synthetic-owner")
    monkeypatch.setattr(owner.__class__, "require_current", AsyncMock())
    chunks = [
        chunk
        async for chunk in routes._prepare_stream(
            request=_Disconnecting(after=10_000), owner=owner, request_id=REQUEST_ID
        )
    ]
    events = [frame[0] for frame in sse_frames(b"".join(chunks).decode())]
    assert events[0] == "stage" and "heartbeat" in events
    assert "complete" not in events and "error" not in events
    pending = list(routes._PREPARE_STREAM_TASKS)
    assert len(pending) == 1 and not pending[0].done()
    release.set()
    await asyncio.gather(*pending)


def _reviewed_drive_app(monkeypatch):
    from api.routes.one import drive_actions

    app = FastAPI()
    app.include_router(drive_actions.router)
    execute = AsyncMock(return_value={"status": "ok", "action": "share"})
    monkeypatch.setattr(drive_actions, "execute_reviewed_drive_action", execute)
    return TestClient(app), app, execute


def _reviewed_body(**changes):
    return {
        "user_id": "owner",
        "conversation_id": "thread-a",
        "directive_id": "dir_" + "0" * 32,
        "action": "share",
        "arguments": {"fileId": "file_1", "email": "a@example.invalid", "role": "reader"},
        "confirmed": True,
        **changes,
    }


def test_a_reviewed_drive_write_needs_the_unlocked_owner_and_an_explicit_confirmation(
    monkeypatch,
):
    client, app, execute = _reviewed_drive_app(monkeypatch)
    path = "/api/one/drive/reviewed-actions/execute"
    assert client.post(path, json=_reviewed_body()).status_code in {401, 403}
    unlock(app, "owner")
    assert client.post(path, json=_reviewed_body(confirmed=False)).status_code == 400
    assert client.post(path, json=_reviewed_body(user_id="someone-else")).status_code == 403
    assert client.post(path, json=_reviewed_body(action="delete")).status_code == 422
    execute.assert_not_awaited()
    assert client.post(path, json=_reviewed_body()).status_code == 200
    execute.assert_awaited_once()
    assert execute.await_args.kwargs["owner_id"] == "owner"


# Requester-only routes (api/routes/drive_request_requester.py): the caller's
# own Google identity, and the review ask.
SHARING = "/api/connectors/google_drive/sharing"
FIREBASE = {"Authorization": "Bearer synthetic-firebase"}


@pytest.fixture
def requester_setup(monkeypatch):
    app = FastAPI()
    app.include_router(requester_routes.router)
    current = AsyncMock(return_value={"user_id": "recipient"})
    monkeypatch.setattr(routes, "require_vault_owner_token", current)
    review = AsyncMock()
    monkeypatch.setattr(requester_routes.requester_store, "request_review", review)
    monkeypatch.setattr(requester_routes, "_service", lambda: SimpleNamespace(store="store"))
    monkeypatch.setattr(requester_routes, "wake_drive_work", AsyncMock(return_value=False))
    return TestClient(app), app, current, review


def test_recipient_identity_is_only_the_callers_own_google_account(requester_setup, monkeypatch):
    client, app, _, _ = requester_setup
    response = client.get(SHARING + "/recipient-identity", headers=FIREBASE)
    assert response.status_code == 401 and "no-store" in response.headers["Cache-Control"]

    unlock(app)
    google_identity(monkeypatch, app)
    response = client.get(SHARING + "/recipient-identity", headers=FIREBASE)
    assert response.status_code == 200
    assert response.json() == {"email": "recipient@example.invalid", "provider": "google.com"}
    assert response.headers["Cache-Control"] == "private, no-store"

    # Another person's Firebase session never reads this vault owner's account.
    google_identity(monkeypatch, app, firebase_uid="someone-else")
    response = client.get(SHARING + "/recipient-identity", headers=FIREBASE)
    assert response.status_code == 403
    assert "recipient@example.invalid" not in response.text


def test_recipient_identity_names_a_missing_or_unverifiable_google_account(
    requester_setup, monkeypatch
):
    client, app, _, _ = requester_setup
    unlock(app)
    google_identity(monkeypatch, app)
    monkeypatch.setattr(
        routes.firebase_auth,
        "get_user",
        Mock(return_value=SimpleNamespace(disabled=False, provider_data=[])),
    )
    response = client.get(SHARING + "/recipient-identity", headers=FIREBASE)
    assert (response.status_code, response.json()["detail"]["code"]) == (
        409,
        "verify_google_identity_required",
    )
    monkeypatch.setattr(
        routes.firebase_auth, "get_user", Mock(side_effect=RuntimeError("provider-body"))
    )
    response = client.get(SHARING + "/recipient-identity", headers=FIREBASE)
    assert (response.status_code, response.json()["detail"]["code"]) == (
        503,
        "identity_verification_unavailable",
    )
    assert "provider-body" not in response.text and "no-store" in response.headers["Cache-Control"]


def test_review_ask_is_vault_bound_and_maps_only_its_own_codes(requester_setup):
    client, app, current, review = requester_setup
    path = f"{SHARING}/requests/{REQUEST_ID}/review-request"
    assert client.post(path, json={}).status_code == 401
    review.assert_not_awaited()

    unlock(app)
    review.return_value = {
        "requestId": REQUEST_ID,
        "reviewRequestedAt": "2026-10-11T08:00:00+00:00",
        "ownerRetry": {"state": "requested", "retryableCount": 1},
        "refund": {"state": "none", "amountCents": None},
    }
    response = client.post(path, json={})
    assert (response.status_code, response.json()) == (200, review.return_value)
    assert response.headers["Cache-Control"] == "private, no-store"
    review.assert_awaited_once_with("store", user_id="recipient", request_id=REQUEST_ID)
    assert current.await_count == 2

    for raised, status, code in (
        ("review_not_available", 409, "review_not_available"),
        ("review_limit_reached", 409, "review_limit_reached"),
        ("request_unavailable", 404, "request_unavailable"),
        ("secret-provider-body", 503, "sharing_unavailable"),
    ):
        review.side_effect = DriveSharingError(raised)
        response = client.post(path, json={})
        assert (response.status_code, response.json()["detail"]["code"]) == (status, code)
        assert "secret-provider-body" not in response.text
        assert "no-store" in response.headers["Cache-Control"]


def test_shared_files_routes_are_owner_only_private_and_queue_only(setup, monkeypatch):
    from api.routes import drive_shared_files as shared_routes

    client, app, _, _ = setup
    app.include_router(shared_routes.router)
    store = SimpleNamespace(
        shared_files=AsyncMock(return_value={"requestId": REQUEST_ID, "files": []}),
        remove_file=AsyncMock(return_value={"status": "removing", "undoable": True}),
        restore_file=AsyncMock(side_effect=DriveSharingError("revocation_pending")),
    )
    monkeypatch.setattr(
        shared_routes, "_service", lambda: SimpleNamespace(store=SimpleNamespace(db=None))
    )
    monkeypatch.setattr(shared_routes, "DriveOwnerSharedFilesStore", lambda db: store)
    base = f"{BASE}/{REQUEST_ID}/shared-files"
    ref = f"{REQUEST_ID}:3"

    # A locked vault reaches nothing.
    assert client.get(base).status_code == 401
    assert client.post(base + "/remove", json={"fileRef": ref}).status_code == 401
    assert not store.shared_files.called and not store.remove_file.called

    unlock(app)
    response = client.get(base)
    assert response.status_code == 200 and "no-store" in response.headers["Cache-Control"]
    store.shared_files.assert_awaited_once_with(
        user_id="recipient", request_id=REQUEST_ID, cursor=None
    )
    # Remove only queues durable work: 202, bound to the authenticated owner.
    assert client.post(base + "/remove", json={"fileRef": ref}).status_code == 202
    store.remove_file.assert_awaited_once_with(
        user_id="recipient", request_id=REQUEST_ID, file_ref=ref
    )
    for body in ({"fileRef": "../other"}, {"fileRef": ref, "userId": "owner"}, {}):
        assert client.post(base + "/remove", json=body).status_code == 422
    assert store.remove_file.await_count == 1

    response = client.post(base + "/restore", json={"fileRef": ref})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "revocation_pending"
    # The requester or anyone else gets the same answer as a missing request.
    store.shared_files.side_effect = DriveSharingError("request_unavailable")
    response = client.get(base)
    assert response.status_code == 404 and "no-store" in response.headers["Cache-Control"]
