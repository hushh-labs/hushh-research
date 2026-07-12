from __future__ import annotations

import base64
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import developer
from hushh_mcp.consent.export_envelope import digest_bytes

_EXPORT_ID = "123e4567-e89b-12d3-a456-426614174000"
_REVISION = 4
_CIPHERTEXT = b"0123456789abcdefghijklmnopqrstuvwxyz"


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(developer.router)
    return app


def _principal(app_id: str = "app_demo"):
    return developer.DeveloperPrincipal(
        app_id=app_id,
        agent_id=f"developer:{app_id}",
        display_name="Demo App",
        allowed_tool_groups=("core_consent",),
    )


def _export_row(**overrides):
    row = {
        "consent_token": "consent_token_demo",
        "user_id": "user_123",
        "scope": "attr.financial.portfolio.*",
        "encrypted_data": base64.b64encode(_CIPHERTEXT).decode(),
        "export_id": _EXPORT_ID,
        "export_revision": _REVISION,
        "refresh_status": "current",
        "envelope_version": 2,
        "app_id": "app_demo",
        "ciphertext_bytes": len(_CIPHERTEXT),
        "ciphertext_sha256": digest_bytes(_CIPHERTEXT),
    }
    row.update(overrides)
    return row


def _client(monkeypatch, *, row=None, principal=None) -> TestClient:
    export_row = _export_row() if row is None else row

    class _FakeConsentDBService:
        async def get_consent_export_by_id(self, export_id: str):
            assert export_id == _EXPORT_ID
            return export_row

    async def _validate(token: str, expected_scope=None):  # noqa: ANN001
        assert token == "consent_token_demo"  # noqa: S105
        return (
            True,
            None,
            SimpleNamespace(
                user_id="user_123",
                agent_id="developer:app_demo",
                scope_str="attr.financial.portfolio.*",
                scope=SimpleNamespace(value="attr.financial.portfolio.*"),
            ),
        )

    monkeypatch.setattr(developer, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(developer, "validate_token_with_db", _validate)
    monkeypatch.setattr(
        developer,
        "authenticate_developer_principal",
        lambda **_kwargs: principal or _principal(),
    )
    return TestClient(_build_app())


def _url(revision: int = _REVISION) -> str:
    return f"/api/v1/scoped-export/resources/{_EXPORT_ID}/revisions/{revision}"


def test_resource_returns_full_ciphertext_with_integrity_headers(monkeypatch):
    response = _client(monkeypatch).get(_url(), headers={"Authorization": "Bearer developer"})

    assert response.status_code == 200
    assert response.content == _CIPHERTEXT
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["x-export-revision"] == str(_REVISION)
    assert response.headers["etag"] == f'"{digest_bytes(_CIPHERTEXT)}"'
    assert response.headers["cache-control"] == "private, no-store"


def test_resource_supports_resumable_byte_ranges(monkeypatch):
    client = _client(monkeypatch)
    first = client.get(_url(), headers={"Authorization": "Bearer developer", "Range": "bytes=0-9"})
    resumed = client.get(
        _url(), headers={"Authorization": "Bearer developer", "Range": "bytes=10-"}
    )

    assert first.status_code == 206
    assert resumed.status_code == 206
    assert first.content + resumed.content == _CIPHERTEXT
    assert first.headers["content-range"] == f"bytes 0-9/{len(_CIPHERTEXT)}"


def test_resource_rejects_unsatisfiable_or_multi_ranges(monkeypatch):
    client = _client(monkeypatch)
    for value in ("bytes=999-1000", "bytes=0-1,3-4", "items=0-1"):
        response = client.get(_url(), headers={"Authorization": "Bearer developer", "Range": value})
        assert response.status_code == 416
        assert response.headers["content-range"] == f"bytes */{len(_CIPHERTEXT)}"


def test_resource_fails_closed_for_cross_app_and_noncurrent_export(monkeypatch):
    cross_app = _client(monkeypatch, principal=_principal("different_app")).get(
        _url(), headers={"Authorization": "Bearer developer"}
    )
    assert cross_app.status_code == 403
    assert cross_app.json()["detail"]["error_code"] == "CROSS_TENANT_DENIED"

    pending = _client(monkeypatch, row=_export_row(refresh_status="refresh_pending")).get(
        _url(), headers={"Authorization": "Bearer developer"}
    )
    assert pending.status_code == 409
    assert pending.json()["detail"]["error_code"] == "EXPORT_REFRESH_PENDING"


def test_resource_rejects_revision_or_ciphertext_integrity_mismatch(monkeypatch):
    wrong_revision = _client(monkeypatch).get(
        _url(revision=5), headers={"Authorization": "Bearer developer"}
    )
    assert wrong_revision.status_code == 404

    corrupt = _client(
        monkeypatch,
        row=_export_row(ciphertext_sha256=f"sha256:{'0' * 64}"),
    ).get(_url(), headers={"Authorization": "Bearer developer"})
    assert corrupt.status_code == 500
    assert corrupt.json()["detail"]["error_code"] == "SCOPED_EXPORT_CORRUPT"


def test_legacy_post_download_endpoint_is_deleted(monkeypatch):
    response = _client(monkeypatch).post(
        "/api/v1/scoped-export/download",
        json={"user_id": "user_123", "consent_token": "consent_token_demo"},
    )
    assert response.status_code == 404
