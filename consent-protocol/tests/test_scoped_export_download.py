"""Tests for POST /api/v1/scoped-export/download.

The download lane serves raw ciphertext bytes so external connectors can fetch
encrypted exports directly in a script instead of routing large base64 blobs
through an LLM context. It must enforce the exact same trust boundary as
/scoped-export: developer principal, consent token validity, user binding,
app binding, and zero-knowledge format.
"""

from __future__ import annotations

import base64
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import developer

_CIPHERTEXT_BYTES = b"encrypted-export-bytes-\x00\x01\x02"
_CIPHERTEXT_B64 = base64.b64encode(_CIPHERTEXT_BYTES).decode("ascii")
_CONSENT_TOKEN = "token_download_1234"  # noqa: S105 - test fixture token id


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(developer.router)
    return app


def _fake_principal():
    return developer.DeveloperPrincipal(
        app_id="app_demo_123",
        agent_id="developer:app_demo_123",
        display_name="Demo App",
        allowed_tool_groups=("core_consent",),
        contact_email="founder@example.com",
    )


def _token_obj(user_id: str = "user_123", agent_id: str = "developer:app_demo_123"):
    return SimpleNamespace(
        user_id=user_id,
        agent_id=agent_id,
        scope_str="attr.financial.*",
        scope=SimpleNamespace(value="attr.financial.*"),
        expires_at=123456789,
    )


def _export_row(**overrides):
    row = {
        "scope": "attr.financial.*",
        "encrypted_data": _CIPHERTEXT_B64,
        "iv": "aXY=",
        "tag": "dGFn",
        "wrapped_key_bundle": {"wrapped_export_key": "wrapped"},
        "export_revision": 7,
        "refresh_status": "current",
        "is_strict_zero_knowledge": True,
    }
    row.update(overrides)
    return row


class _FakeConsentDBService:
    def __init__(self, export_row):
        self._export_row = export_row

    async def get_consent_export(self, token_id: str):
        return self._export_row


def _wire(monkeypatch, *, export_row, token_obj=None, valid=True, reason=None):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "ConsentDBService", lambda: _FakeConsentDBService(export_row))

    async def _validate(token: str, expected_scope=None):  # noqa: ANN001
        return (valid, reason, token_obj if valid else None)

    monkeypatch.setattr(developer, "validate_token_with_db", _validate)
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )


def _post_download(client: TestClient, *, user_id: str = "user_123"):
    return client.post(
        "/api/v1/scoped-export/download?token=hdk_demo",
        json={"user_id": user_id, "consent_token": _CONSENT_TOKEN},
    )


def test_download_returns_raw_bytes_with_metadata_headers(monkeypatch):
    _wire(monkeypatch, export_row=_export_row(), token_obj=_token_obj())

    response = _post_download(TestClient(_build_app()))

    assert response.status_code == 200
    assert response.content == _CIPHERTEXT_BYTES
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["x-export-iv"] == "aXY="
    assert response.headers["x-export-tag"] == "dGFn"
    assert response.headers["x-export-scope"] == "attr.financial.*"
    assert response.headers["x-export-revision"] == "7"
    assert response.headers["cache-control"] == "no-store"


def test_download_rejects_invalid_consent_token(monkeypatch):
    _wire(monkeypatch, export_row=_export_row(), valid=False, reason="expired")

    response = _post_download(TestClient(_build_app()))

    assert response.status_code == 401
    assert response.json()["detail"]["error_code"] == "INVALID_CONSENT_TOKEN"


def test_download_rejects_user_mismatch(monkeypatch):
    _wire(monkeypatch, export_row=_export_row(), token_obj=_token_obj(user_id="other_user"))

    response = _post_download(TestClient(_build_app()))

    assert response.status_code == 403
    assert response.json()["detail"]["error_code"] == "CONSENT_TOKEN_USER_MISMATCH"


def test_download_rejects_app_mismatch(monkeypatch):
    _wire(
        monkeypatch,
        export_row=_export_row(),
        token_obj=_token_obj(agent_id="developer:someone_else"),
    )

    response = _post_download(TestClient(_build_app()))

    assert response.status_code == 403
    assert response.json()["detail"]["error_code"] == "CONSENT_TOKEN_APP_MISMATCH"


def test_download_404_when_no_export(monkeypatch):
    class _EmptyService:
        async def get_consent_export(self, token_id: str):
            return None

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    monkeypatch.setattr(developer, "ConsentDBService", lambda: _EmptyService())

    async def _validate(token: str, expected_scope=None):  # noqa: ANN001
        return (True, None, _token_obj())

    monkeypatch.setattr(developer, "validate_token_with_db", _validate)
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )

    response = _post_download(TestClient(_build_app()))

    assert response.status_code == 404
    assert response.json()["detail"]["error_code"] == "SCOPED_EXPORT_NOT_FOUND"


def test_download_rejects_legacy_export_without_invalidation_side_effect(monkeypatch):
    _wire(
        monkeypatch,
        export_row=_export_row(is_strict_zero_knowledge=False),
        token_obj=_token_obj(),
    )

    response = _post_download(TestClient(_build_app()))

    assert response.status_code == 410
    assert response.json()["detail"]["error_code"] == "LEGACY_EXPORT_INVALIDATED"


def test_download_500_on_corrupt_base64(monkeypatch):
    _wire(
        monkeypatch,
        export_row=_export_row(encrypted_data="not-valid-base64!!!"),
        token_obj=_token_obj(),
    )

    response = _post_download(TestClient(_build_app()))

    assert response.status_code == 500
    assert response.json()["detail"]["error_code"] == "SCOPED_EXPORT_CORRUPT"


def test_json_endpoint_unchanged_by_shared_helper(monkeypatch):
    """The refactor to a shared auth helper must not change /scoped-export."""
    _wire(monkeypatch, export_row=_export_row(), token_obj=_token_obj())

    response = TestClient(_build_app()).post(
        "/api/v1/scoped-export?token=hdk_demo",
        json={"user_id": "user_123", "consent_token": _CONSENT_TOKEN},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "success"
    assert payload["encrypted_data"] == _CIPHERTEXT_B64
    assert payload["iv"] == "aXY="


def test_root_payload_lists_download_endpoint(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")

    payload = developer._developer_root_payload()

    assert payload["endpoints"]["scoped_export_download"] == "/api/v1/scoped-export/download"
