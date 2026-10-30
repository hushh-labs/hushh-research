"""Real SQL: the owner's review decides whether Allow accepts a One copy.

On 2026-10-28 every Allow of a new combined request returned 422. The review
never projected the sealed copy request, so no web Allow surface sent the
acceptance the copy gate requires. These tests build the Allow body from the
review exactly as the web clients do and post it through the production routes.
Only providers are fake.
"""

# ruff: noqa: F401, F811 -- canonical isolated PostgreSQL fixtures

from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import text

from api.routes import drive_sharing as routes
from hushh_mcp.services.drive_request_bulk_service import DriveRequestBulkService
from hushh_mcp.services.drive_sharing_service import DriveSharingService
from tests.services.test_document_delivery_background import copies
from tests.services.test_drive_autoshare_pay_then_stream_postgres import (
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    flow,
    lifecycle,
    request_bulk,
    sharing,
)

pytestmark = pytest.mark.feature_protected_documents

REQUESTS = "/api/connectors/google_drive/sharing/requests"


@pytest.fixture
async def owner_api(flow, monkeypatch):
    """The production sharing routes, signed in as the owner, on the test database."""
    owner = SimpleNamespace(user_id="owner", require_current=AsyncMock())
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[routes._owner] = lambda: owner
    app.dependency_overrides[routes._content_owner] = lambda: owner
    monkeypatch.setattr(
        routes,
        "_service",
        lambda: DriveSharingService(oauth=SimpleNamespace(), store=flow.sharing),
    )
    # Review context reads only the sharing store before a search starts.
    context = DriveRequestBulkService(
        sharing=flow.sharing,
        search=SimpleNamespace(),
        bulk=flow.bulk,
        owner_index=SimpleNamespace(),
    )
    monkeypatch.setattr(routes, "_request_bulk_service", lambda: context)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://owner.test") as client:
        yield client


async def review_allow_body(api, request_id, amount_cents):
    """The Feed and Consent Center Allow body, built from the owner's review."""
    review = await api.get(f"{REQUESTS}/{request_id}/review")
    assert review.status_code == 200, review.json()
    terms = review.json()
    body = {"revision": terms["revision"], "amountCents": amount_cents, "confirmed": True}
    if terms.get("oneCopyRequested") is True:
        body["oneCopyAccepted"] = True
    return terms, body


def effects(flow):
    """Owner Allow, copy consent and payment order rows this request has."""
    with flow.db.engine.connect() as connection:
        values = {"request": flow.request_id}
        allowed = connection.execute(
            text(
                "SELECT owner_allowed_at IS NOT NULL FROM drive_share_requests WHERE request_id=:request"
            ),
            values,
        ).scalar_one()
        consents = connection.execute(
            text("""SELECT consent_version, revoked_at FROM document_delivery_background_requests
              WHERE request_id=:request"""),
            values,
        ).all()
        orders = connection.execute(
            text("SELECT count(*) FROM drive_request_payment_orders WHERE request_id=:request"),
            values,
        ).scalar_one()
    return allowed, [tuple(row) for row in consents], orders


@pytest.mark.parametrize("amount_cents", [50, 550, 1000])
async def test_review_driven_allow_accepts_a_combined_request_once(
    flow, copies, owner_api, amount_cents
):
    await flow.request(trusted=False, allow=False)
    terms, body = await review_allow_body(owner_api, flow.request_id, amount_cents)
    assert terms.get("oneCopyRequested") is True, "the review must carry the sealed copy request"
    allow = f"{REQUESTS}/{flow.request_id}/allow"

    # The 2026-10-28 body: no acceptance. Refused, and nothing is granted or ordered.
    without = {key: value for key, value in body.items() if key != "oneCopyAccepted"}
    refused = await owner_api.post(allow, json=without)
    assert refused.status_code == 422
    assert refused.json()["detail"]["code"] == "invalid_argument"
    assert refused.json()["detail"]["reason"] == "owner_copy_consent_missing"
    assert effects(flow) == (False, [], 0)

    allowed = await owner_api.post(allow, json=body)
    assert allowed.status_code == 202, allowed.json()
    allowed_effects = effects(flow)
    assert allowed_effects == (True, [("one-server-copy-v2", None)], 1)

    # A lost response is retried with the same body: still one Allow, consent and order.
    retried = await owner_api.post(allow, json=body)
    assert retried.status_code == 202, retried.json()
    assert effects(flow) == allowed_effects
    assert flow.create_session.call_count == 0


async def test_trusted_combined_request_cannot_be_priced_around_the_one_allow(
    flow, copies, owner_api
):
    await flow.request(trusted=True, allow=False)
    terms, body = await review_allow_body(owner_api, flow.request_id, 550)
    assert terms.get("oneCopyRequested") is True and terms.get("allowAvailable") is True
    # Set price would start automatic Trusted sharing with no copy consent.
    assert terms.get("priceOnlyAvailable") is not True
    priced = await owner_api.post(
        f"{REQUESTS}/{flow.request_id}/price",
        json={"revision": terms["revision"], "amountCents": 550, "confirmed": True},
    )
    assert priced.status_code == 409
    assert priced.json()["detail"]["code"] == "request_already_decided"

    allowed = await owner_api.post(f"{REQUESTS}/{flow.request_id}/allow", json=body)
    assert allowed.status_code == 202, allowed.json()
    assert effects(flow)[:2] == (True, [("one-server-copy-v2", None)])


async def test_drive_only_review_never_carries_or_accepts_a_one_copy(flow, owner_api):
    await flow.request(trusted=False, allow=False)
    terms, body = await review_allow_body(owner_api, flow.request_id, 550)
    assert "oneCopyRequested" not in terms and "oneCopyAccepted" not in body
    allow = f"{REQUESTS}/{flow.request_id}/allow"

    refused = await owner_api.post(allow, json={**body, "oneCopyAccepted": True})
    assert refused.status_code == 422
    assert refused.json()["detail"]["code"] == "invalid_argument"
    assert refused.json()["detail"]["reason"] == "owner_copy_consent_unexpected"

    allowed = await owner_api.post(allow, json=body)
    assert allowed.status_code == 202, allowed.json()
