"""Tests: marketplace IAM schema error must not leak internal hints or exc detail.

Covers the three public marketplace endpoints that catch IAMSchemaNotReadyError:
  GET /api/marketplace/rias
  GET /api/marketplace/investors
  GET /api/marketplace/ria/{ria_id}

Each endpoint must return 503 with an opaque message -- no migration commands,
no file paths, no raw exception text.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

INTERNAL_STRINGS = [
    "db/migrate.py",
    "verify_iam_schema",
    "python ",
    "--iam",
    "hint",
    "schema is not ready",
]


def _make_app():
    from fastapi import FastAPI
    from api.routes.marketplace import router

    app = FastAPI()
    app.include_router(router)
    return app


@pytest.fixture()
def client():
    return TestClient(_make_app(), raise_server_exceptions=False)


def _patch_iam_not_ready(method_name: str):
    from hushh_mcp.services.ria_iam_service import IAMSchemaNotReadyError

    target = f"api.routes.marketplace.RIAIAMService.{method_name}"
    return patch(target, new_callable=AsyncMock, side_effect=IAMSchemaNotReadyError("schema missing"))


class TestListRiasIAMLeak:
    def test_returns_503(self, client):
        with _patch_iam_not_ready("search_marketplace_rias"):
            resp = client.get("/api/marketplace/rias")
        assert resp.status_code == 503

    def test_no_hint_field(self, client):
        with _patch_iam_not_ready("search_marketplace_rias"):
            resp = client.get("/api/marketplace/rias")
        assert "hint" not in resp.json()

    def test_no_internal_strings(self, client):
        with _patch_iam_not_ready("search_marketplace_rias"):
            resp = client.get("/api/marketplace/rias")
        body = resp.text.lower()
        for s in INTERNAL_STRINGS:
            assert s not in body, f"Leaked internal string in /rias response: {s!r}"

    def test_code_field_present(self, client):
        with _patch_iam_not_ready("search_marketplace_rias"):
            resp = client.get("/api/marketplace/rias")
        assert resp.json().get("code") == "IAM_SCHEMA_NOT_READY"


class TestListInvestorsIAMLeak:
    def test_returns_503(self, client):
        with _patch_iam_not_ready("search_marketplace_investors"):
            resp = client.get("/api/marketplace/investors")
        assert resp.status_code == 503

    def test_no_hint_field(self, client):
        with _patch_iam_not_ready("search_marketplace_investors"):
            resp = client.get("/api/marketplace/investors")
        assert "hint" not in resp.json()

    def test_no_internal_strings(self, client):
        with _patch_iam_not_ready("search_marketplace_investors"):
            resp = client.get("/api/marketplace/investors")
        body = resp.text.lower()
        for s in INTERNAL_STRINGS:
            assert s not in body, f"Leaked internal string in /investors response: {s!r}"


class TestGetRiaIAMLeak:
    def test_returns_503(self, client):
        with _patch_iam_not_ready("get_marketplace_ria_profile"):
            resp = client.get("/api/marketplace/ria/some-id")
        assert resp.status_code == 503

    def test_no_hint_field(self, client):
        with _patch_iam_not_ready("get_marketplace_ria_profile"):
            resp = client.get("/api/marketplace/ria/some-id")
        assert "hint" not in resp.json()

    def test_no_internal_strings(self, client):
        with _patch_iam_not_ready("get_marketplace_ria_profile"):
            resp = client.get("/api/marketplace/ria/some-id")
        body = resp.text.lower()
        for s in INTERNAL_STRINGS:
            assert s not in body, f"Leaked internal string in /ria profile response: {s!r}"
