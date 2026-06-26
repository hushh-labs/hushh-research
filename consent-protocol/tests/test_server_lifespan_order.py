"""Proof that the async lifespan manager preserves on_event registration order.

server.py previously registered 12 @app.on_event("startup") and 3
@app.on_event("shutdown") hooks. FastAPI runs on_event handlers in
registration order. After migrating to a single @asynccontextmanager
lifespan, the call order must still match that original registration
order exactly, since these hooks have real ordering dependencies
(e.g. the connection pool must exist before anything that queries it).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import server

_EXPECTED_STARTUP_ORDER = [
    "startup_pool_and_iam_cache",
    "startup_consent_listener",
    "startup_ticker_cache",
    "startup_pkm_scope_validator_warmup",
    "startup_consent_token_verifier_prewarm",
    "startup_regulated_runtime_guards",
    "startup_required_schema_guard",
    "startup_remote_mcp_transport",
    "startup_market_cache_store_table",
    "startup_market_insights_refresh",
    "startup_gmail_receipts_sync",
    "startup_consent_revocation_worker",
]

_EXPECTED_SHUTDOWN_ORDER = [
    "shutdown_remote_mcp_transport",
    "shutdown_gmail_receipts_sync",
    "shutdown_email_delivery_queue",
]


def test_lifespan_runs_hooks_in_original_registration_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    for name in _EXPECTED_STARTUP_ORDER + _EXPECTED_SHUTDOWN_ORDER:
        def _make_stub(hook_name: str):
            async def _stub(*_args, **_kwargs) -> None:
                calls.append(hook_name)

            return _stub

        monkeypatch.setattr(server, name, _make_stub(name))

    with TestClient(server.app):
        pass

    assert calls == _EXPECTED_STARTUP_ORDER + _EXPECTED_SHUTDOWN_ORDER
