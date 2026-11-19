"""First-party Follow-ups retains Mail authority without a browser vault token."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one import calendar_email_followups as routes
from hushh_mcp.services.calendar_email_followup_account import SelectedMailAccessError

pytestmark = pytest.mark.usefixtures("shared_hub_owner")
SELECTION = {"user_id": "owner", "account_id": "account-b"}


def app():
    result = FastAPI()
    result.include_router(routes.router)
    return result


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv("CALENDAR_EMAIL_FOLLOWUPS", "true")
    monkeypatch.setenv("CALENDAR_EMAIL_FOLLOWUP_DRAIN_ENABLED", "true")
    monitor = SimpleNamespace(grant_epoch_digest="epoch", checkpoint={"mode": "history"})
    store = SimpleNamespace(
        monitor=AsyncMock(return_value=monitor),
        require_monitor_current=AsyncMock(),
        list_conversations=AsyncMock(return_value={"conversations": [], "account_id": "account-b"}),
        acquire_scan=AsyncMock(return_value=None),
    )
    grant = SimpleNamespace(epoch_digest="epoch", require_current=AsyncMock())
    monkeypatch.setattr(routes, "CalendarEmailFollowupStore", lambda: store)
    monkeypatch.setattr(routes, "open_selected_mail_grant", AsyncMock(return_value=grant))
    application = app()
    application.dependency_overrides[require_firebase_auth] = lambda: "owner"
    application.dependency_overrides[require_vault_owner_token] = lambda: (_ for _ in ()).throw(
        AssertionError("Follow-up workspace requested vault authority")
    )
    return TestClient(application), store, grant


def test_list_uses_firebase_and_selected_mail_without_vault(configured):
    client, store, grant = configured
    response = client.post("/api/one/calendar/followups/list", json=SELECTION)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    store.list_conversations.assert_awaited_once()
    grant.require_current.assert_awaited_once()
    store.require_monitor_current.assert_awaited_once()


def test_payload_cannot_select_another_owner(configured):
    client, store, _ = configured
    response = client.post(
        "/api/one/calendar/followups/list", json={**SELECTION, "user_id": "other"}
    )
    assert response.status_code == 403
    store.monitor.assert_not_awaited()


def test_revoked_mail_never_returns_saved_rows(configured):
    client, store, grant = configured
    grant.require_current.side_effect = SelectedMailAccessError("selected_mail_permission_required")
    response = client.post("/api/one/calendar/followups/list", json=SELECTION)
    assert response.status_code == 403
    assert "conversations" not in response.json()


def test_page_scan_does_not_run_inference_or_reset_checkpoint(configured, monkeypatch):
    client, store, _ = configured
    scan = AsyncMock(side_effect=AssertionError("Page waited for inference"))
    monkeypatch.setattr(routes, "scan_once", scan)
    response = client.post("/api/one/calendar/followups/scan", json=SELECTION)
    assert response.status_code == 200
    assert response.json()["state"] == "scheduled"
    store.acquire_scan.assert_not_awaited()
    scan.assert_not_awaited()


def test_busy_retry_does_not_claim_it_reset_active_work(configured):
    client, _, _ = configured
    response = client.post("/api/one/calendar/followups/scan", json={**SELECTION, "retry": True})
    assert response.status_code == 200
    assert response.json() == {"state": "not_due", "retry_accepted": False}


def test_anonymous_request_is_rejected():
    response = TestClient(app()).post("/api/one/calendar/followups/list", json=SELECTION)
    assert response.status_code in {401, 403}


def test_booking_rechecks_request_before_provider_write(configured, monkeypatch):
    import base64
    from datetime import UTC, datetime, timedelta

    from hushh_mcp.services.calendar_email_followup_crypto import FollowupCipher
    from hushh_mcp.services.calendar_email_followup_store import CalendarEmailFollowupStore

    client, store, _ = configured
    monitor = store.monitor.return_value
    monitor.user_id, monitor.account_id, monitor.generation = "owner", "account-b", "generation"
    cipher_store = CalendarEmailFollowupStore(
        db=object(), cipher=FollowupCipher(base64.urlsafe_b64encode(b"x" * 32).decode())
    )
    store._seal, store._open = cipher_store._seal, cipher_store._open
    request_id = "11111111-1111-4111-8111-111111111111"
    row = {
        "id": request_id,
        "revision": 2,
        "kind": "meeting",
        "state": "needs_review",
        "booking_state": None,
    }
    store.resolve_request = AsyncMock(return_value={"conversation_id": "thread"})
    store.detail = AsyncMock(return_value={"requests": [row]})
    writes = []

    async def execute(**kwargs):
        await kwargs["before_create"]()
        writes.append("event")
        return {"action": "create", "event": {"id": "event"}}

    calendar = SimpleNamespace(
        propose=AsyncMock(
            return_value={
                "proposal_id": "proposal-b",
                "expires_at": (datetime.now(UTC) + timedelta(minutes=5)).isoformat(),
                "plan": {},
            }
        ),
        execute=AsyncMock(side_effect=execute),
    )
    monkeypatch.setattr(routes, "account_schedule", lambda _: SimpleNamespace(calendar=calendar))
    review = client.post(
        "/api/one/calendar/followups/booking/review",
        json={
            **SELECTION,
            "request_id": request_id,
            "expected_revision": 2,
            "title": "Review",
            "start_at": "2099-11-18T10:00:00Z",
            "end_at": "2099-11-18T10:30:00Z",
        },
    )
    assert review.status_code == 200
    store.detail.side_effect = [{"requests": [row]}, {"requests": [{**row, "revision": 3}]}]
    result = client.post(
        "/api/one/calendar/followups/booking/execute",
        json={
            **SELECTION,
            "request_id": request_id,
            "expected_revision": 2,
            "proposal_id": "proposal-b",
            "review_token": review.json()["review_token"],
        },
    )
    assert result.status_code == 409
    assert writes == []
    calendar.execute.assert_awaited_once()
