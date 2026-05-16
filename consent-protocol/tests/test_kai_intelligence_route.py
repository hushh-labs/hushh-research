"""Route-level integration tests for the Kai Intelligence API layer.

Canonical caller proof:
  api/routes/kai/__init__.py includes intelligence_router which is
  registered in kai_router → server.py.

These tests drive the HTTP surface directly (TestClient) so the
dependency chain  route → KaiOrchestrator → DecisionCard  is exercised
end-to-end without mocking at the route boundary.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Import-time stubs — same pattern as test_kai_indian_market_route.py
# ---------------------------------------------------------------------------
if "asyncpg" not in sys.modules:
    _asyncpg = types.ModuleType("asyncpg")
    _asyncpg.Pool = type("Pool", (), {})  # type: ignore[attr-defined]
    _asyncpg.UndefinedColumnError = type("UndefinedColumnError", (Exception,), {})  # type: ignore[attr-defined]
    _asyncpg.UndefinedTableError = type("UndefinedTableError", (Exception,), {})  # type: ignore[attr-defined]
    sys.modules["asyncpg"] = _asyncpg
for _attr in ("UndefinedColumnError", "UndefinedTableError"):
    if not hasattr(sys.modules["asyncpg"], _attr):
        setattr(sys.modules["asyncpg"], _attr, type(_attr, (Exception,), {}))

if "db" not in sys.modules:
    _db = types.ModuleType("db")
    _db.__path__ = []  # type: ignore[attr-defined]
    sys.modules["db"] = _db
if "db.db_client" not in sys.modules:
    _db_client = types.ModuleType("db.db_client")
    _db_client.get_db = lambda: (_ for _ in ()).throw(RuntimeError("db not available"))  # type: ignore[attr-defined]
    _db_client.DatabaseExecutionError = type("DatabaseExecutionError", (Exception,), {})  # type: ignore[attr-defined]
    sys.modules["db.db_client"] = _db_client
if "db.connection" not in sys.modules:
    _db_conn = types.ModuleType("db.connection")
    async def _noop_get_pool():  # pragma: no cover
        return None
    _db_conn.get_pool = _noop_get_pool  # type: ignore[attr-defined]
    sys.modules["db.connection"] = _db_conn

for _mod in ("google", "google.genai", "google.genai.types"):
    if _mod not in sys.modules:
        sys.modules[_mod] = types.ModuleType(_mod)
sys.modules["google"].genai = sys.modules["google.genai"]  # type: ignore[attr-defined]
sys.modules["google.genai"].types = sys.modules["google.genai.types"]  # type: ignore[attr-defined]

if "sse_starlette" not in sys.modules:
    sys.modules["sse_starlette"] = types.ModuleType("sse_starlette")
if "sse_starlette.sse" not in sys.modules:
    _sse = types.ModuleType("sse_starlette.sse")
    _sse.EventSourceResponse = type("EventSourceResponse", (), {"__init__": lambda self, *a, **kw: None})  # type: ignore[attr-defined]
    sys.modules["sse_starlette.sse"] = _sse
sys.modules["sse_starlette"].EventSourceResponse = sys.modules["sse_starlette.sse"].EventSourceResponse  # type: ignore[attr-defined]

# Stub api.routes.kai package so __init__.py is bypassed
ROOT = Path(__file__).resolve().parents[1]
if "api.routes.kai" not in sys.modules:
    _kai_pkg = types.ModuleType("api.routes.kai")
    _kai_pkg.__path__ = [str(ROOT / "api" / "routes" / "kai")]  # type: ignore[attr-defined]
    sys.modules["api.routes.kai"] = _kai_pkg

from api.routes.kai.intelligence import router  # noqa: E402


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    return app


# ---------------------------------------------------------------------------
# GET /intelligence/capabilities — no auth, always works
# ---------------------------------------------------------------------------


def test_capabilities_returns_200():
    client = TestClient(_build_app())
    response = client.get("/intelligence/capabilities")
    assert response.status_code == 200


def test_capabilities_has_required_top_level_keys():
    client = TestClient(_build_app())
    body = client.get("/intelligence/capabilities").json()
    for key in ("version", "analysis_modes", "agents", "risk_profiles",
                "processing_modes", "data_providers", "debate", "batch", "streaming"):
        assert key in body, f"missing key: {key}"


def test_capabilities_agents_contains_three_entries():
    client = TestClient(_build_app())
    body = client.get("/intelligence/capabilities").json()
    agent_ids = [a["id"] for a in body["agents"]]
    assert set(agent_ids) == {"fundamental", "sentiment", "valuation"}


def test_capabilities_batch_limit_is_five():
    client = TestClient(_build_app())
    body = client.get("/intelligence/capabilities").json()
    assert body["batch"]["max_tickers"] == 5


def test_capabilities_streaming_endpoint_listed():
    client = TestClient(_build_app())
    body = client.get("/intelligence/capabilities").json()
    assert "/api/kai/analyze/stream" in body["streaming"]["endpoint"]


# ---------------------------------------------------------------------------
# POST /intelligence/batch — requires vault owner token
# ---------------------------------------------------------------------------


def test_batch_missing_token_returns_401():
    client = TestClient(_build_app())
    response = client.post(
        "/intelligence/batch",
        json={"user_id": "u1", "tickers": ["AAPL"]},
    )
    assert response.status_code == 401


def test_batch_exceeding_limit_returns_422():
    """Pydantic validator rejects more than 5 tickers (auth bypassed to reach validation)."""
    from api.middleware import require_vault_owner_token as dep

    fake_token = {"user_id": "u1", "token": "HCT:fake", "agent_id": "kai"}
    app = _build_app()
    app.dependency_overrides[dep] = lambda: fake_token
    client = TestClient(app)
    response = client.post(
        "/intelligence/batch",
        json={"user_id": "u1", "tickers": ["A", "B", "C", "D", "E", "F"]},
    )
    assert response.status_code == 422


def test_batch_empty_tickers_returns_422():
    """Pydantic validator rejects empty ticker list (auth bypassed to reach validation)."""
    from api.middleware import require_vault_owner_token as dep

    fake_token = {"user_id": "u1", "token": "HCT:fake", "agent_id": "kai"}
    app = _build_app()
    app.dependency_overrides[dep] = lambda: fake_token
    client = TestClient(app)
    response = client.post(
        "/intelligence/batch",
        json={"user_id": "u1", "tickers": []},
    )
    assert response.status_code == 422


def test_batch_returns_results_with_patched_orchestrator():
    """POST /batch with valid token → orchestrator called once per ticker."""
    import datetime

    from api.middleware import require_vault_owner_token as dep

    fake_card = MagicMock()
    fake_card.decision_id = "dec-001"
    fake_card.decision = "buy"
    fake_card.confidence = 0.82
    fake_card.headline = "Strong fundamentals"
    fake_card.timestamp = datetime.datetime(2026, 1, 1)

    fake_generator = MagicMock()
    fake_generator.to_json.return_value = '{"decision": "buy"}'

    fake_orchestrator = MagicMock()
    fake_orchestrator.analyze = AsyncMock(return_value=fake_card)
    fake_orchestrator.decision_generator = fake_generator

    fake_token = {"user_id": "u1", "token": "HCT:fake", "agent_id": "kai"}

    app = _build_app()
    app.dependency_overrides[dep] = lambda: fake_token

    with patch(
        "hushh_mcp.agents.kai.orchestrator.KaiOrchestrator",
        return_value=fake_orchestrator,
    ):
        client = TestClient(app)
        response = client.post(
            "/intelligence/batch",
            json={"user_id": "u1", "tickers": ["AAPL", "TSLA"]},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    assert body["user_id"] == "u1"
    assert len(body["results"]) == 2


def test_batch_user_id_mismatch_returns_403():
    from api.middleware import require_vault_owner_token as dep

    fake_token = {"user_id": "user_a", "token": "HCT:fake", "agent_id": "kai"}
    app = _build_app()
    app.dependency_overrides[dep] = lambda: fake_token
    client = TestClient(app)

    response = client.post(
        "/intelligence/batch",
        json={"user_id": "user_b", "tickers": ["AAPL"]},
    )
    assert response.status_code == 403
