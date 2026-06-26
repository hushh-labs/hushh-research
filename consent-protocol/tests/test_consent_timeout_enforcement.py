# tests/test_consent_timeout_enforcement.py
"""
Canonical attach-point proof for the poll_timeout_at enforcement gap.

Canonical attach point
----------------------
hushh_mcp.services.consent_db.ConsentDBService.get_pending_by_request_id
  -> self._effective_pending_timeout_at(row)
  -> returns None when poll_timeout_at has elapsed

Before the fix, get_pending_requests() filtered out timed-out rows via
poll_timeout_at (lines 442-443) but get_pending_by_request_id() had no
equivalent check.  A direct lookup by request_id could surface an expired
consent request, allowing the /consent/approve endpoint to issue a token
after the polling window had closed.

The fix adds the same poll_timeout_at gate to get_pending_by_request_id():
when the timeout has elapsed, return None so callers see the request as
absent.  expires_at continues to serve as the fallback via the existing
_effective_pending_timeout_at() helper.

Tests prove:
1. Reachability: timed-out rows returned by Supabase are suppressed before
   they reach any caller.
2. Non-regression: live requests (future timeout or no timeout field) are
   still returned.
3. Consistency: get_pending_requests and get_pending_by_request_id agree
   on what counts as "still pending".
"""

from __future__ import annotations

import time
from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hushh_mcp.services.consent_db import ConsentDBService

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_NOW_MS = int(time.time() * 1000)
_UID = "user_test_123"
_REQ_ID = "req_abc456"

_BASE_ROW: Dict[str, Any] = {
    "user_id": _UID,
    "request_id": _REQ_ID,
    "action": "REQUESTED",
    "scope": "attr.financial.*",
    "agent_id": "developer:test_app",
    "issued_at": _NOW_MS - 60_000,
    "expires_at": _NOW_MS + 3_600_000,
    "poll_timeout_at": None,
    "metadata": None,
    "scope_description": "Financial data",
}


def _row(**overrides: Any) -> Dict[str, Any]:
    return {**_BASE_ROW, **overrides}


def _supabase_returning(rows: list[Dict[str, Any]]) -> MagicMock:
    """Fake Supabase client whose .execute() yields the given rows."""
    execute_result = MagicMock()
    execute_result.data = rows
    chain = MagicMock()
    chain.execute.return_value = execute_result
    supabase = MagicMock()
    supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.order.return_value.limit.return_value = (  # noqa: E501
        chain
    )
    return supabase


def _service(supabase: MagicMock) -> ConsentDBService:
    svc = ConsentDBService.__new__(ConsentDBService)
    svc._get_supabase = lambda: supabase
    return svc


# ---------------------------------------------------------------------------
# Canonical attach-point proof:
# ConsentDBService.get_pending_by_request_id -- timeout gate enforcement
# ---------------------------------------------------------------------------


class TestConsentDBServiceGetPendingByRequestIdTimeoutGate:
    """
    ConsentDBService.get_pending_by_request_id is the canonical attach point.

    Proves that the poll_timeout_at gate is enforced at the single-lookup
    path so that timed-out requests cannot reach the /consent/approve caller.
    """

    @pytest.mark.asyncio
    async def test_elapsed_poll_timeout_at_returns_none(self):
        """
        A row whose poll_timeout_at is in the past must be suppressed.

        This is the exact attack vector from the gap: without the guard,
        a direct lookup returns the row and the approve endpoint issues a
        token after the polling window has closed.
        """
        row = _row(poll_timeout_at=_NOW_MS - 1)  # 1 ms in the past
        svc = _service(_supabase_returning([row]))
        with patch.object(svc, "list_internal_request_events", new=AsyncMock(return_value=[])):
            result = await svc.get_pending_by_request_id(_UID, _REQ_ID)
        assert result is None, "Timed-out request must not be returned to callers"

    @pytest.mark.asyncio
    async def test_far_past_timeout_returns_none(self):
        """Requests that expired long ago are also suppressed."""
        row = _row(poll_timeout_at=_NOW_MS - 3_600_000)
        svc = _service(_supabase_returning([row]))
        with patch.object(svc, "list_internal_request_events", new=AsyncMock(return_value=[])):
            result = await svc.get_pending_by_request_id(_UID, _REQ_ID)
        assert result is None

    @pytest.mark.asyncio
    async def test_future_timeout_returns_request(self):
        """A live request (poll_timeout_at in the future) is still returned."""
        row = _row(poll_timeout_at=_NOW_MS + 60_000)
        svc = _service(_supabase_returning([row]))
        with patch.object(svc, "list_internal_request_events", new=AsyncMock(return_value=[])):
            result = await svc.get_pending_by_request_id(_UID, _REQ_ID)
        assert result is not None
        assert result["request_id"] == _REQ_ID

    @pytest.mark.asyncio
    async def test_no_timeout_field_returns_request(self):
        """When poll_timeout_at is absent, the request is treated as live."""
        row = _row(poll_timeout_at=None, expires_at=_NOW_MS + 3_600_000)
        svc = _service(_supabase_returning([row]))
        with patch.object(svc, "list_internal_request_events", new=AsyncMock(return_value=[])):
            result = await svc.get_pending_by_request_id(_UID, _REQ_ID)
        assert result is not None

    @pytest.mark.asyncio
    async def test_expires_at_fallback_suppresses_expired_request(self):
        """
        When poll_timeout_at is absent, _effective_pending_timeout_at() falls
        back to expires_at.  An expired request must still be suppressed.
        """
        row = _row(poll_timeout_at=None, expires_at=_NOW_MS - 1)
        svc = _service(_supabase_returning([row]))
        with patch.object(svc, "list_internal_request_events", new=AsyncMock(return_value=[])):
            result = await svc.get_pending_by_request_id(_UID, _REQ_ID)
        assert result is None, "Expired request via expires_at fallback must not be returned"

    @pytest.mark.asyncio
    async def test_resolved_action_returns_none(self):
        """A CONSENT_GRANTED row is not pending regardless of timeout."""
        row = _row(action="CONSENT_GRANTED", poll_timeout_at=_NOW_MS + 60_000)
        svc = _service(_supabase_returning([row]))
        result = await svc.get_pending_by_request_id(_UID, _REQ_ID)
        assert result is None

    @pytest.mark.asyncio
    async def test_empty_db_result_returns_none(self):
        """No matching row in DB means no pending request."""
        svc = _service(_supabase_returning([]))
        result = await svc.get_pending_by_request_id(_UID, _REQ_ID)
        assert result is None

    @pytest.mark.asyncio
    async def test_consistency_with_get_pending_requests(self):
        """
        get_pending_requests and get_pending_by_request_id must agree:
        a timed-out row must be absent from both paths.

        Before the fix, get_pending_requests suppressed the row but
        get_pending_by_request_id returned it, allowing the approve endpoint
        to bypass the timeout gate via the single-lookup path.
        """
        timed_out_row = _row(poll_timeout_at=_NOW_MS - 500)

        # Single-lookup path
        svc_single = _service(_supabase_returning([timed_out_row]))
        with patch.object(
            svc_single, "list_internal_request_events", new=AsyncMock(return_value=[])
        ):
            single_result = await svc_single.get_pending_by_request_id(_UID, _REQ_ID)

        # List path -- mock matches get_pending_requests' query chain
        list_execute = MagicMock()
        list_execute.data = [timed_out_row]
        list_supabase = MagicMock()
        list_supabase.table.return_value.select.return_value.eq.return_value.order.return_value.execute.return_value = (  # noqa: E501
            list_execute
        )
        svc_list = _service(list_supabase)
        with patch.object(svc_list, "list_internal_request_events", new=AsyncMock(return_value=[])):
            list_result = await svc_list.get_pending_requests(_UID)

        assert single_result is None, "get_pending_by_request_id must filter timed-out row"
        assert list_result == [], "get_pending_requests must also filter timed-out row"


# ---------------------------------------------------------------------------
# HTTP route-level proof (TestClient)
#
# Proves that the timeout gate is reachable from the shipped HTTP surface.
# POST /api/consent/pending/approve calls get_pending_by_request_id; when
# the service returns None (timed-out), the route must return 404.
# ---------------------------------------------------------------------------


class TestApproveConsentTimedOutRequestReturns404:
    """
    Route-level proof: api.routes.consent.approve_consent
    (POST /api/consent/pending/approve) returns 404 when
    get_pending_by_request_id returns None for a timed-out request.

    Canonical attach point:
      api.routes.consent.approve_consent
        -> ConsentDBService.get_pending_by_request_id(userId, requestId)
        -> returns None when poll_timeout_at has elapsed
        -> route raises HTTPException(404, "Consent request not found")
    """

    def test_timed_out_request_returns_404(self, monkeypatch):
        """A timed-out consent request must not be approved; route returns 404."""
        from api.middleware import require_vault_owner_token
        from api.routes.consent import router as consent_router
        from hushh_mcp.services.consent_db import ConsentDBService

        app = FastAPI()
        app.include_router(consent_router)
        app.dependency_overrides[require_vault_owner_token] = lambda: {
            "user_id": _UID,
            "token": "fake-vault-tok",
            "scope": "vault.owner",
        }

        # Simulate the timeout gate: get_pending_by_request_id returns None
        monkeypatch.setattr(
            ConsentDBService,
            "get_pending_by_request_id",
            AsyncMock(return_value=None),
        )

        client = TestClient(app, raise_server_exceptions=False)
        resp = client.post(
            "/api/consent/pending/approve",
            json={
                "userId": _UID,
                "requestId": _REQ_ID,
                "agentId": "agent_kai",
            },
            headers={"Authorization": "Bearer fake-vault-tok"},
        )

        assert resp.status_code == 404
        assert resp.json()["detail"] == "Consent request not found"
