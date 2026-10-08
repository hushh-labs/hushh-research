"""HTTP auth and privacy contract for live Gmail receipt scan/detail."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.kai import gmail
from hushh_mcp.services.gmail_receipts_service import GmailApiError


@pytest.fixture(autouse=True)
def shared_owner_placement(monkeypatch):
    """These route fixtures exercise Shared mail; private refusals live in the route-wall suite."""
    from hushh_mcp.services import owner_placement_guard

    monkeypatch.setattr(
        owner_placement_guard, "get_owner_hosting_mode", AsyncMock(return_value="shared")
    )


def _item(source_id: str = "gmail_live_source.sig") -> dict:
    return {
        "id": -1,
        "source_id": source_id,
        "receipt_key": source_id,
        "source_kind": "gmail_live",
        "gmail_message_id": "provider-message-id",
        "gmail_thread_id": "provider-thread-id",
        "merchant_name": "Myntra",
        "merchant_domain": "myntra.com",
        "sender_domain": "updates.myntra.com",
        "from_name": "Myntra",
        "from_email": "receipts@myntra.com",
        "order_id": "ORDER-100",
        "amount": 100.0,
        "currency": "INR",
        "receipt_date": "2026-10-04T00:00:00+00:00",
        "gmail_internal_date": "2026-10-04T00:00:00+00:00",
        "subject": "Order receipt",
        "preview": "Order receipt preview",
        "snippet": "Order receipt preview",
        "classification_confidence": 0.98,
        "classification_source": "agent",
        "event_type": "purchase",
        "status": "paid",
        "identifier_kind": "order",
        "identifier_value": "ORDER-100",
        "short_detail": "Monthly membership",
        "cleaned_preview": "Monthly membership paid INR 100.00",
    }


def _app(*, firebase_uid: str = "owner", vault_owner: str | None = "owner") -> FastAPI:
    app = FastAPI()
    app.include_router(gmail.router)
    app.dependency_overrides[require_firebase_auth] = lambda: firebase_uid
    if vault_owner is not None:
        app.dependency_overrides[require_vault_owner_token] = lambda: {
            "user_id": vault_owner,
            "token": "vault-token",
        }
    return app


def test_scan_requires_three_way_owner_match_before_service(monkeypatch):
    service = MagicMock()
    service.scan = AsyncMock(return_value={"items": []})
    monkeypatch.setattr(gmail, "_live_receipts_service", lambda: service)

    wrong_firebase = TestClient(_app(firebase_uid="other")).post(
        "/gmail/receipts/scan", json={"user_id": "owner"}
    )
    wrong_vault = TestClient(_app(vault_owner="other")).post(
        "/gmail/receipts/scan", json={"user_id": "owner"}
    )

    assert wrong_firebase.status_code == 403
    assert wrong_vault.status_code == 403
    service.scan.assert_not_awaited()


def test_scan_requires_vault_authorization_before_service(monkeypatch):
    service = MagicMock()
    service.scan = AsyncMock(return_value={"items": []})
    monkeypatch.setattr(gmail, "_live_receipts_service", lambda: service)

    response = TestClient(_app(vault_owner=None), raise_server_exceptions=False).post(
        "/gmail/receipts/scan", json={"user_id": "owner"}
    )

    assert response.status_code == 401
    service.scan.assert_not_awaited()


def test_scan_is_sealed_bounded_and_no_store(monkeypatch):
    service = MagicMock()
    service.scan = AsyncMock(
        return_value={
            "items": [],
            "page": 1,
            "per_page": 6,
            "returned_count": 0,
            "has_more": False,
            "coverage": {
                "source": "gmail_live",
                "listed_count": 0,
                "candidate_count": 0,
                "matched_count": 0,
                "pages_scanned": 1,
                "max_messages": 6,
                "max_pages": 10,
                "reached_limit": False,
                "query_scope": "receipt_signals_all_mail_except_spam_trash",
                "rejection_counts": {
                    "missing_receipt_signal": 0,
                    "extractor_not_receipt": 0,
                },
                "evidence_counts": {
                    "gmail_category": 0,
                    "subject_signal": 0,
                    "body_signal": 0,
                    "verified_merchant": 0,
                    "order_candidate": 0,
                    "total_candidate": 0,
                },
            },
        }
    )
    monkeypatch.setattr(gmail, "_live_receipts_service", lambda: service)
    revalidate = AsyncMock()
    monkeypatch.setattr(gmail, "_revalidate_live_receipt_access", revalidate)

    response = TestClient(_app()).post(
        "/gmail/receipts/scan",
        json={"user_id": "owner", "page": 1, "per_page": 6},
    )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["pragma"] == "no-cache"
    kwargs = service.scan.await_args.kwargs
    assert kwargs["user_id"] == "owner"
    assert kwargs["consent_token"] == "vault-token"
    assert kwargs["page"] == 1
    assert kwargs["per_page"] == 6
    assert callable(kwargs["require_access"])
    asyncio.run(kwargs["require_access"]())
    revalidate.assert_not_awaited()
    asyncio.run(kwargs["require_access"]())
    revalidate.assert_awaited_once()


async def test_disconnected_receipt_request_cancels_only_its_scan():
    cancelled = asyncio.Event()

    class _DisconnectedRequest:
        async def is_disconnected(self) -> bool:
            return True

    async def blocked_scan() -> dict:
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
        return {}

    with pytest.raises(HTTPException) as caught:
        await gmail._await_live_receipt_scan(
            request=_DisconnectedRequest(),  # type: ignore[arg-type]
            operation=blocked_scan(),
        )

    assert caught.value.status_code == 499
    assert cancelled.is_set()


def test_detail_accepts_only_bounded_source_id_in_post_body(monkeypatch):
    service = MagicMock()
    service.detail = AsyncMock(return_value={"item": _item(), "email_excerpt": None})
    monkeypatch.setattr(gmail, "_live_receipts_service", lambda: service)
    revalidate = AsyncMock()
    monkeypatch.setattr(gmail, "_revalidate_live_receipt_access", revalidate)

    response = TestClient(_app()).post(
        "/gmail/receipts/detail",
        json={"user_id": "owner", "source_id": "gmail_live_source.sig"},
    )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    kwargs = service.detail.await_args.kwargs
    assert kwargs["user_id"] == "owner"
    assert kwargs["source_id"] == "gmail_live_source.sig"
    assert "gmail_message_id" not in kwargs
    asyncio.run(kwargs["require_access"]())
    revalidate.assert_not_awaited()
    asyncio.run(kwargs["require_access"]())
    revalidate.assert_awaited_once()


def test_detail_requires_three_way_owner_and_vault_authorization(monkeypatch):
    service = MagicMock()
    service.detail = AsyncMock(return_value={"item": _item(), "email_excerpt": None})
    monkeypatch.setattr(gmail, "_live_receipts_service", lambda: service)

    payload = {"user_id": "owner", "source_id": "gmail_live_source.sig"}
    wrong_firebase = TestClient(_app(firebase_uid="other")).post(
        "/gmail/receipts/detail", json=payload
    )
    wrong_vault = TestClient(_app(vault_owner="other")).post("/gmail/receipts/detail", json=payload)
    missing_vault = TestClient(_app(vault_owner=None), raise_server_exceptions=False).post(
        "/gmail/receipts/detail", json=payload
    )

    assert wrong_firebase.status_code == 403
    assert wrong_vault.status_code == 403
    assert missing_vault.status_code == 401
    service.detail.assert_not_awaited()


def test_live_receipt_request_bounds_reject_before_service(monkeypatch):
    service = MagicMock()
    service.scan = AsyncMock(return_value={"items": []})
    service.detail = AsyncMock(return_value={"item": {}})
    monkeypatch.setattr(gmail, "_live_receipts_service", lambda: service)

    too_many = TestClient(_app()).post(
        "/gmail/receipts/scan", json={"user_id": "owner", "per_page": 13}
    )
    oversized = TestClient(_app()).post(
        "/gmail/receipts/detail",
        json={"user_id": "owner", "source_id": "x" * 341},
    )

    assert too_many.status_code == 422
    assert oversized.status_code == 422
    service.scan.assert_not_awaited()
    service.detail.assert_not_awaited()


def test_live_receipt_errors_do_not_echo_provider_or_mailbox_values(monkeypatch, caplog):
    service = MagicMock()
    service.scan = AsyncMock(
        side_effect=GmailApiError(
            "private-owner private-message private-order private-amount",
            status_code=502,
            code="UNTRUSTED_PROVIDER_CODE",
            payload={"access_token": "private-token", "body": "private-body"},
        )
    )
    monkeypatch.setattr(gmail, "_live_receipts_service", lambda: service)
    monkeypatch.setattr(gmail, "_revalidate_live_receipt_access", AsyncMock())

    response = TestClient(_app()).post("/gmail/receipts/scan", json={"user_id": "owner"})
    rendered = response.text + caplog.text

    assert response.status_code == 502
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json()["detail"] == {
        "code": "GMAIL_RECEIPT_UNAVAILABLE",
        "message": "Receipts are temporarily unavailable. Please try again.",
    }
    for private_value in (
        "private-owner",
        "private-message",
        "private-order",
        "private-amount",
        "private-token",
        "private-body",
    ):
        assert private_value not in rendered
