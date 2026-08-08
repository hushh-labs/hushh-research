"""Routes for the claim dossier row: GET /ria/dossier and POST /ria/dossier/retry.

Own-row-only visibility, the 404-when-none contract, and the retry state
machine — only the visible failure states flip back to ``queued`` under
FOR UPDATE and re-dispatch the worker; a delivered dossier is a conflict.
"""

from __future__ import annotations

import asyncio
import sys
import types
from datetime import UTC, datetime
from typing import Any

import asyncpg
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# Stub the rate-limit middleware *before* importing the route module so the
# decorator is a no-op during tests (same pattern as test_ria_claim_flow).
rate_limit_module = types.ModuleType("api.middlewares.rate_limit")


class _NoopLimiter:
    def limit(self, *_args, **_kwargs):
        def decorator(func):
            return func

        return decorator


rate_limit_module.limiter = _NoopLimiter()  # type: ignore[attr-defined]
sys.modules.setdefault("api.middlewares.rate_limit", rate_limit_module)

import hushh_mcp.services.ria_dossier_service as dossier_module  # noqa: E402
from api.middleware import require_firebase_auth  # noqa: E402
from api.routes import ria as ria_module  # noqa: E402
from hushh_mcp.services.ria_claim_service import RIAClaimService  # noqa: E402

_TEST_UID = "user_dossier_routes_123"
_OTHER_UID = "user_dossier_routes_999"


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


def _row(**overrides: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": 1,
        "user_id": _TEST_UID,
        "status": "sent",
        "result_summary": "One-line summary.",
        "result_markdown": "# Dossier\n\nBody.",
        "requested_at": datetime(2026, 8, 8, 12, 0, 0, tzinfo=UTC),
        "completed_at": datetime(2026, 8, 8, 12, 30, 0, tzinfo=UTC),
        "mail_recipient": "uat-inbox@hushh.ai",
        "mail_intended_recipient": "reg@olympuspeaks.com",
        "error": None,
    }
    row.update(overrides)
    return row


class _FakeDossierDb:
    """In-memory stand-in for the ria_claim_dossiers table."""

    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self.rows = list(rows or [])
        self.for_update_selects = 0
        self.retry_updates = 0


class _FakeTransaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _FakeConn:
    def __init__(self, db: _FakeDossierDb) -> None:
        self._db = db

    def transaction(self) -> _FakeTransaction:
        return _FakeTransaction()

    async def fetchrow(self, query: str, *args: Any):
        normalized = " ".join(query.split())
        assert normalized.startswith("SELECT id, status, result_summary"), normalized
        assert "WHERE user_id = $1" in normalized
        if normalized.endswith("FOR UPDATE"):
            self._db.for_update_selects += 1
        own = [row for row in self._db.rows if row["user_id"] == args[0]]
        if not own:
            return None
        own.sort(key=lambda row: (row["requested_at"], row["id"]), reverse=True)
        return own[0]

    async def execute(self, query: str, *args: Any) -> str:
        normalized = " ".join(query.split())
        assert normalized.startswith(
            "UPDATE ria_claim_dossiers SET status = 'queued', error = NULL"
        ), normalized
        self._db.retry_updates += 1
        for row in self._db.rows:
            if row["id"] == args[0]:
                row["status"] = "queued"
                row["error"] = None
                row["completed_at"] = None
        return "UPDATE 1"


class _MissingTableConn:
    def transaction(self) -> _FakeTransaction:
        return _FakeTransaction()

    async def fetchrow(self, query: str, *args: Any):
        raise asyncpg.UndefinedTableError("relation ria_claim_dossiers does not exist")


class _FakeAcquire:
    def __init__(self, conn: Any) -> None:
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _FakePool:
    def __init__(self, conn: Any) -> None:
        self._conn = conn

    def acquire(self) -> _FakeAcquire:
        return _FakeAcquire(self._conn)


def _install_db(monkeypatch, rows: list[dict[str, Any]] | None = None) -> _FakeDossierDb:
    db = _FakeDossierDb(rows)
    pool = _FakePool(_FakeConn(db))

    async def _fake_get_pool():
        return pool

    monkeypatch.setattr(ria_module, "get_pool", _fake_get_pool)
    return db


def _install_claim_context(monkeypatch, context: dict[str, Any] | None) -> None:
    async def _fake_load(self, user_id: str):
        return dict(context) if context is not None else None

    monkeypatch.setattr(RIAClaimService, "_load_claim_context", _fake_load)


def _install_redispatch_recorder(monkeypatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    def _fake_redispatch(*, dossier_id: int, user_id: str, context: dict[str, Any]) -> None:
        calls.append({"dossier_id": dossier_id, "user_id": user_id, "context": context})

    monkeypatch.setattr(ria_module, "_redispatch_dossier", _fake_redispatch)
    return calls


def _claim_context() -> dict[str, Any]:
    return {
        "ria_profile_id": "11111111-2222-3333-4444-555555555555",
        "metadata": {"claim_type": "individual", "verification_level": "verified"},
    }


def _build_app(uid: str = _TEST_UID) -> FastAPI:
    app = FastAPI()
    app.include_router(ria_module.router)
    app.dependency_overrides[require_firebase_auth] = lambda: uid
    return app


# ---------------------------------------------------------------------------
# GET /ria/dossier
# ---------------------------------------------------------------------------


def test_get_dossier_returns_404_when_none(monkeypatch):
    _install_db(monkeypatch)
    response = TestClient(_build_app()).get("/api/ria/dossier")
    assert response.status_code == 404


def test_get_dossier_returns_own_row_shape(monkeypatch):
    _install_db(monkeypatch, [_row()])
    response = TestClient(_build_app()).get("/api/ria/dossier")
    assert response.status_code == 200
    assert response.json() == {
        "status": "sent",
        "summary": "One-line summary.",
        "markdown": "# Dossier\n\nBody.",
        "requested_at": "2026-08-08T12:00:00+00:00",
        "completed_at": "2026-08-08T12:30:00+00:00",
        "mail": {"status": "sent", "recipient_masked": "r•••@olympuspeaks.com"},
    }
    # The raw addresses and internal columns never leave the backend.
    assert "reg@olympuspeaks.com" not in response.text
    assert "uat-inbox@hushh.ai" not in response.text


def test_get_dossier_serves_the_latest_row(monkeypatch):
    _install_db(
        monkeypatch,
        [
            _row(id=1, status="sent"),
            _row(
                id=2,
                status="scanning",
                requested_at=datetime(2026, 8, 8, 13, 0, 0, tzinfo=UTC),
                completed_at=None,
                mail_recipient=None,
                mail_intended_recipient=None,
            ),
        ],
    )
    response = TestClient(_build_app()).get("/api/ria/dossier")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "scanning"
    assert body["mail"] == {"status": "pending", "recipient_masked": None}


def test_get_dossier_foreign_row_invisible(monkeypatch):
    _install_db(monkeypatch, [_row(user_id=_OTHER_UID)])
    response = TestClient(_build_app()).get("/api/ria/dossier")
    assert response.status_code == 404


def test_get_dossier_tolerates_missing_table(monkeypatch):
    async def _fake_get_pool():
        return _FakePool(_MissingTableConn())

    monkeypatch.setattr(ria_module, "get_pool", _fake_get_pool)
    response = TestClient(_build_app()).get("/api/ria/dossier")
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# POST /ria/dossier/retry
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("status", ["scan_failed", "send_failed", "send_blocked_test_unset"])
def test_retry_flips_failed_row_to_queued_and_redispatches(monkeypatch, status):
    db = _install_db(monkeypatch, [_row(status=status, error="scan_start_status_500")])
    _install_claim_context(monkeypatch, _claim_context())
    calls = _install_redispatch_recorder(monkeypatch)
    response = TestClient(_build_app()).post("/api/ria/dossier/retry")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "queued"
    assert body["completed_at"] is None
    assert body["mail"]["status"] == "pending"
    assert db.rows[0]["status"] == "queued"
    assert db.rows[0]["error"] is None
    assert db.for_update_selects == 1
    assert db.retry_updates == 1
    assert calls == [{"dossier_id": 1, "user_id": _TEST_UID, "context": _claim_context()}]


@pytest.mark.parametrize("status", ["queued", "scanning", "generated", "sent", "blocked_no_email"])
def test_retry_from_non_failed_status_is_conflict(monkeypatch, status):
    db = _install_db(monkeypatch, [_row(status=status)])
    _install_claim_context(monkeypatch, _claim_context())
    calls = _install_redispatch_recorder(monkeypatch)
    response = TestClient(_build_app()).post("/api/ria/dossier/retry")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "DOSSIER_NOT_RETRYABLE"
    assert db.rows[0]["status"] == status
    assert db.retry_updates == 0
    assert calls == []


def test_retry_returns_404_when_no_row(monkeypatch):
    _install_db(monkeypatch)
    _install_claim_context(monkeypatch, _claim_context())
    calls = _install_redispatch_recorder(monkeypatch)
    response = TestClient(_build_app()).post("/api/ria/dossier/retry")
    assert response.status_code == 404
    assert calls == []


def test_retry_foreign_row_invisible(monkeypatch):
    db = _install_db(monkeypatch, [_row(user_id=_OTHER_UID, status="scan_failed")])
    _install_claim_context(monkeypatch, _claim_context())
    calls = _install_redispatch_recorder(monkeypatch)
    response = TestClient(_build_app()).post("/api/ria/dossier/retry")
    assert response.status_code == 404
    assert db.rows[0]["status"] == "scan_failed"
    assert calls == []


def test_retry_without_claim_snapshot_is_conflict_and_never_flips(monkeypatch):
    db = _install_db(monkeypatch, [_row(status="scan_failed")])
    _install_claim_context(monkeypatch, None)
    calls = _install_redispatch_recorder(monkeypatch)
    response = TestClient(_build_app()).post("/api/ria/dossier/retry")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "CLAIM_CONTEXT_MISSING"
    assert db.rows[0]["status"] == "scan_failed"
    assert db.retry_updates == 0
    assert calls == []


# ---------------------------------------------------------------------------
# Re-dispatch wiring: the worker gets the persisted claim snapshot back
# ---------------------------------------------------------------------------


async def test_redispatch_spawns_worker_with_claim_snapshot(monkeypatch):
    worker_calls: list[dict[str, Any]] = []

    async def _recording_worker(self, **kwargs: Any) -> None:
        worker_calls.append(kwargs)

    monkeypatch.setattr(dossier_module.RIADossierService, "_run_worker", _recording_worker)
    context = _claim_context()
    ria_module._redispatch_dossier(dossier_id=7, user_id=_TEST_UID, context=context)
    await asyncio.gather(*dossier_module._BACKGROUND_TASKS)
    assert worker_calls == [
        {
            "dossier_id": 7,
            "user_id": _TEST_UID,
            "ria_profile_id": "11111111-2222-3333-4444-555555555555",
            "claim_type": "individual",
            "reference_metadata": context["metadata"],
        }
    ]
