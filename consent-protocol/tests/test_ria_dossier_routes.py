"""Routes for the claim dossier row: GET /ria/dossier and POST /ria/dossier/retry.

Own-row-only visibility, the 404-when-none contract, and the retry state
machine — only the visible failure states flip back to ``queued`` under
FOR UPDATE and re-dispatch the worker; a delivered dossier is a conflict.
"""

from __future__ import annotations

import asyncio
import importlib
import sys
import types
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# Stub the rate-limit middleware *before* importing the route module so the
# decorator is a no-op during tests (same pattern as test_ria_claim_flow).
#
# RateLimits carries the real per-route budget constants -- ria.py's other
# routes read them at decoration time (e.g. RateLimits.RIA_NEARBY_DIRECTORY_READ),
# so the stub module needs the real class, not just a limiter double, or the
# import fails before a single test runs. Imported via importlib rather than
# a plain `import`, which would cache the REAL module under this same
# sys.modules key -- the assignment below has to be the thing that wins, or
# ria.py's own `from api.middlewares.rate_limit import ... limiter` would
# resolve to the real, rate-limiting one instead of the no-op double.
_real_rate_limit_module = importlib.import_module("api.middlewares.rate_limit")

_fake_rate_limit_module = types.ModuleType("api.middlewares.rate_limit")


class _NoopLimiter:
    def limit(self, *_args, **_kwargs):
        def decorator(func):
            return func

        return decorator


_fake_rate_limit_module.limiter = _NoopLimiter()  # type: ignore[attr-defined]
_fake_rate_limit_module.RateLimits = _real_rate_limit_module.RateLimits  # type: ignore[attr-defined]

# Swapped in only for the one import that reads it at decoration time, then put
# straight back. sys.modules is process-global -- leaving the fake in place
# would silently hand every OTHER test file that imports this module later in
# the same pytest session a limiter with none of the real one's behaviour
# (no `.enabled`, no `_TYPED_RATE_LIMIT_PATHS`), breaking tests that have
# nothing to do with ria.py. What ria.py's own `from ... import limiter,
# RateLimits` already bound into its own namespace is unaffected by restoring
# this afterward -- that binding happened by value, at the line below.
sys.modules["api.middlewares.rate_limit"] = _fake_rate_limit_module
try:
    from api.routes import ria as ria_module  # noqa: E402
finally:
    sys.modules["api.middlewares.rate_limit"] = _real_rate_limit_module

import hushh_mcp.services.ria_dossier_service as dossier_module  # noqa: E402
from api.middleware import require_firebase_auth  # noqa: E402
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
        "scan_id": None,
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
        assert normalized.startswith("SELECT id, status, scan_id, result_summary"), normalized
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


# ---------------------------------------------------------------------------
# Reviving a stranded scan
#
# The worker is an in-process task on a CPU-throttled Cloud Run service: when
# an instance stops receiving requests its CPU is withdrawn and the poll
# freezes mid-flight, leaving the row in `scanning` while the scan itself
# finishes upstream. The read that renders the card is a request, so it is
# also what can resume the poll.
# ---------------------------------------------------------------------------


def _install_resume_recorder(monkeypatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    async def _fake_resume(row: Any, user_id: str) -> None:
        calls.append({"id": row["id"], "status": row["status"], "user_id": user_id})

    monkeypatch.setattr(ria_module, "_resume_stalled_dossier", _fake_resume)
    return calls


def test_reading_a_scanning_row_resumes_its_poll(monkeypatch):
    _install_db(monkeypatch, [_row(status="scanning", scan_id="scan-1", completed_at=None)])
    _install_claim_context(monkeypatch, _claim_context())
    workers: list[dict[str, Any]] = []

    async def _fake_worker(self, **kwargs: Any) -> None:
        workers.append(kwargs)

    monkeypatch.setattr(
        "hushh_mcp.services.ria_dossier_service.RIADossierService._run_worker", _fake_worker
    )
    ria_module._DOSSIER_RESUMING.clear()

    response = TestClient(_build_app()).get("/api/ria/dossier")
    assert response.status_code == 200
    assert response.json()["status"] == "scanning"
    assert len(workers) == 1
    # Resumed against the stored scan, so no second scan is ever started.
    assert workers[0]["resume_scan_id"] == "scan-1"
    assert workers[0]["dossier_id"] == 1


def test_reading_a_stale_queued_row_resumes_it_from_scratch(monkeypatch):
    """The other stall point: withdrawn CPU before the worker's first turn.

    A `queued` row has no scan id, so there is nothing to resume a poll
    against -- the worker has to re-enter from the beginning: resolve email,
    build the scan payload, start a fresh scan. `resume_scan_id=""` is what
    tells it to do that rather than treat the empty string as a scan id.
    """
    stale_requested_at = datetime.now(UTC) - timedelta(minutes=5)
    _install_db(
        monkeypatch,
        [_row(status="queued", scan_id=None, completed_at=None, requested_at=stale_requested_at)],
    )
    _install_claim_context(monkeypatch, _claim_context())
    workers: list[dict[str, Any]] = []

    async def _fake_worker(self, **kwargs: Any) -> None:
        workers.append(kwargs)

    monkeypatch.setattr(
        "hushh_mcp.services.ria_dossier_service.RIADossierService._run_worker", _fake_worker
    )
    ria_module._DOSSIER_RESUMING.clear()

    response = TestClient(_build_app()).get("/api/ria/dossier")
    assert response.status_code == 200
    assert response.json()["status"] == "queued"
    assert len(workers) == 1
    assert workers[0]["resume_scan_id"] == ""
    assert workers[0]["dossier_id"] == 1


def test_a_queued_row_still_within_the_grace_window_is_left_alone(monkeypatch):
    """The window a live worker needs to reach its first status write.

    Requested five seconds ago is well within `_DOSSIER_QUEUED_STALL_THRESHOLD`
    -- indistinguishable, from a single read, from dispatch still legitimately
    resolving the recipient email and building the scan payload. Resuming it
    here would start a second scan racing the first.
    """
    fresh_requested_at = datetime.now(UTC) - timedelta(seconds=5)
    _install_db(
        monkeypatch,
        [_row(status="queued", scan_id=None, completed_at=None, requested_at=fresh_requested_at)],
    )
    _install_claim_context(monkeypatch, _claim_context())
    workers: list[dict[str, Any]] = []

    async def _fake_worker(self, **kwargs: Any) -> None:
        workers.append(kwargs)

    monkeypatch.setattr(
        "hushh_mcp.services.ria_dossier_service.RIADossierService._run_worker", _fake_worker
    )
    ria_module._DOSSIER_RESUMING.clear()

    assert TestClient(_build_app()).get("/api/ria/dossier").status_code == 200
    assert workers == []


@pytest.mark.parametrize(
    "overrides",
    [
        {"status": "sent"},
        {"status": "scan_failed"},
        # Freshly queued, well inside the stall threshold — a worker that is
        # genuinely still starting up must never be raced into a second scan.
        {"status": "queued", "scan_id": None, "requested_at": datetime.now(UTC)},
        {"status": "scanning", "scan_id": None},
        {
            "status": "scanning",
            "scan_id": "scan-1",
            "completed_at": datetime(2026, 8, 8, 12, 30, 0, tzinfo=UTC),
        },
    ],
    ids=["sent", "failed", "queued-not-yet-stale", "scanning-no-scan-id", "already-completed"],
)
def test_a_row_that_is_not_mid_scan_is_never_resumed(monkeypatch, overrides):
    _install_db(monkeypatch, [_row(**overrides)])
    _install_claim_context(monkeypatch, _claim_context())
    workers: list[dict[str, Any]] = []

    async def _fake_worker(self, **kwargs: Any) -> None:
        workers.append(kwargs)

    monkeypatch.setattr(
        "hushh_mcp.services.ria_dossier_service.RIADossierService._run_worker", _fake_worker
    )
    ria_module._DOSSIER_RESUMING.clear()

    assert TestClient(_build_app()).get("/api/ria/dossier").status_code == 200
    assert workers == []


def test_a_failing_resume_never_fails_the_read(monkeypatch):
    _install_db(monkeypatch, [_row(status="scanning", scan_id="scan-1", completed_at=None)])

    async def _boom(row: Any, user_id: str) -> None:
        raise RuntimeError("resume exploded")

    monkeypatch.setattr(ria_module, "_resume_stalled_dossier", _boom)
    response = TestClient(_build_app()).get("/api/ria/dossier")
    assert response.status_code == 200
    assert response.json()["status"] == "scanning"


@pytest.mark.asyncio
async def test_a_second_read_does_not_stack_a_second_worker(monkeypatch):
    """A page that reloads while the poll runs must not double the workers."""
    _install_claim_context(monkeypatch, _claim_context())
    starts = 0
    release = asyncio.Event()

    async def _hanging_worker(self, **kwargs: Any) -> None:
        nonlocal starts
        starts += 1
        await release.wait()

    monkeypatch.setattr(
        "hushh_mcp.services.ria_dossier_service.RIADossierService._run_worker", _hanging_worker
    )
    ria_module._DOSSIER_RESUMING.clear()
    row = _row(status="scanning", scan_id="scan-1", completed_at=None)

    await ria_module._resume_stalled_dossier(row, _TEST_UID)
    await ria_module._resume_stalled_dossier(row, _TEST_UID)
    await asyncio.sleep(0)  # let the spawned workers reach their first await

    assert ria_module._DOSSIER_RESUMING == {1}
    assert starts == 1

    release.set()
    await asyncio.sleep(0)
    assert ria_module._DOSSIER_RESUMING == set()  # released for a later resume
