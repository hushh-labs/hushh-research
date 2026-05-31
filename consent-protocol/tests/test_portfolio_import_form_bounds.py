from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.kai import portfolio


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(portfolio.router)
    app.dependency_overrides[portfolio.require_vault_owner_token] = lambda: {"user_id": "user_123"}
    return app


def _portfolio_files(filename: str = "statement.csv"):
    return {"file": (filename, b"Symbol,Quantity\nAAPL,1\n", "text/csv")}


def test_portfolio_import_form_user_ids_reject_oversized_values_before_dispatch(
    monkeypatch,
):
    def _unexpected_import_service():
        raise AssertionError("portfolio import validation should run before service dispatch")

    class _UnexpectedRunManager:
        async def start_or_get_active(self, **_kwargs):
            raise AssertionError("portfolio import validation should run before run dispatch")

        def stream_run_events(self, **_kwargs):
            raise AssertionError("portfolio import validation should run before stream dispatch")

    monkeypatch.setattr(portfolio, "get_portfolio_import_service", _unexpected_import_service)
    monkeypatch.setattr(portfolio, "_IMPORT_RUN_MANAGER", _UnexpectedRunManager())

    client = TestClient(_build_app())
    oversized_user_id = "u" * 129

    responses = [
        client.post(
            "/portfolio/import",
            data={"user_id": oversized_user_id},
            files=_portfolio_files(),
        ),
        client.post(
            "/portfolio/import/run/start",
            data={"user_id": oversized_user_id},
            files=_portfolio_files(),
        ),
        client.post(
            "/portfolio/import/stream",
            data={"user_id": oversized_user_id},
            files=_portfolio_files(),
        ),
    ]

    assert [response.status_code for response in responses] == [422, 422, 422]
