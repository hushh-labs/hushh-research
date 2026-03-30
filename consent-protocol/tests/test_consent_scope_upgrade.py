from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import consent


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(consent.router)
    app.dependency_overrides[consent.require_vault_owner_token] = lambda: {"user_id": "user_123"}
    return app


def test_approve_consent_supersedes_narrower_tokens(monkeypatch):
    events: list[dict] = []
    deleted_exports: list[str] = []
    revoked_tokens: list[str] = []
    issued_grant = "grant_issued_scope_upgrade"

    class _FakeConsentDBService:
        async def get_pending_by_request_id(self, user_id: str, request_id: str):
            assert user_id == "user_123"
            assert request_id == "req_upgrade"
            return {
                "request_id": request_id,
                "developer": "developer:app_demo_123",
                "scope": "attr.financial.analytics.*",
                "metadata": {
                    "developer_app_display_name": "Demo App",
                    "expiry_hours": 24,
                    "is_scope_upgrade": True,
                    "existing_granted_scopes": ["attr.financial.analytics.quality_metrics"],
                    "additional_access_summary": (
                        "This app already has access to attr.financial.analytics.quality_metrics "
                        "and is now requesting additional access to attr.financial.analytics.*."
                    ),
                },
            }

        async def find_covering_active_token(self, *_args, **_kwargs):
            return None

        async def store_consent_export(self, **_kwargs):
            return True

        async def insert_event(self, **kwargs):
            events.append(kwargs)
            return len(events)

        async def get_superseded_active_tokens(
            self,
            user_id: str,
            *,
            requested_scope: str,
            agent_id: str | None = None,
        ):
            assert user_id == "user_123"
            assert requested_scope == "attr.financial.analytics.*"
            assert agent_id == "developer:app_demo_123"
            return [
                {
                    "scope": "attr.financial.analytics.quality_metrics",
                    "token_id": "token_old",
                    "request_id": "req_old",
                }
            ]

        async def delete_consent_export(self, consent_token: str):
            deleted_exports.append(consent_token)
            return True

    monkeypatch.setattr(consent, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(
        consent,
        "issue_token",
        lambda **_kwargs: SimpleNamespace(token=issued_grant, expires_at=123456789),
    )
    monkeypatch.setattr(consent, "revoke_token", lambda token: revoked_tokens.append(token))
    monkeypatch.setattr(
        consent.RIAIAMService,
        "sync_relationship_from_consent_action",
        lambda self, **_kwargs: None,
    )

    client = TestClient(_build_app())
    response = client.post(
        "/api/consent/pending/approve",
        json={
            "userId": "user_123",
            "requestId": "req_upgrade",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "approved"
    assert payload["consent_token"] == issued_grant
    assert payload["granted_scope"] == "attr.financial.analytics.*"
    assert payload["superseded_scopes"] == ["attr.financial.analytics.quality_metrics"]

    assert revoked_tokens == ["token_old"]
    assert deleted_exports == ["token_old"]
    assert [event["action"] for event in events] == ["CONSENT_GRANTED", "REVOKED"]
    assert events[0]["metadata"]["is_scope_upgrade"] is True
    assert events[1]["metadata"]["superseded_by_broader_scope"] is True
    assert events[1]["metadata"]["superseded_by_scope"] == "attr.financial.analytics.*"


def test_approve_consent_fails_when_export_persistence_fails(monkeypatch):
    class _FakeConsentDBService:
        async def get_pending_by_request_id(self, user_id: str, request_id: str):
            assert user_id == "user_123"
            assert request_id == "req_export_failure"
            return {
                "request_id": request_id,
                "developer": "developer:app_demo_123",
                "scope": "attr.financial.analytics.quality_metrics",
                "metadata": {
                    "request_source": "developer_api_v1",
                    "requester_actor_type": "developer",
                    "connector_public_key": "connector_public_key_demo",
                    "connector_key_id": "connector_demo",
                    "connector_wrapping_alg": "X25519-AES256-GCM",
                },
            }

        async def find_covering_active_token(self, *_args, **_kwargs):
            return None

        async def store_consent_export(self, **_kwargs):
            return False

    monkeypatch.setattr(consent, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(
        consent,
        "issue_token",
        lambda **_kwargs: SimpleNamespace(token="grant_failure", expires_at=123456789),  # noqa: S106
    )
    monkeypatch.setattr(
        consent.RIAIAMService,
        "sync_relationship_from_consent_action",
        lambda self, **_kwargs: None,
    )

    client = TestClient(_build_app())
    response = client.post(
        "/api/consent/pending/approve",
        json={
            "userId": "user_123",
            "requestId": "req_export_failure",
            "encryptedData": "ciphertext",
            "encryptedIv": "iv",
            "encryptedTag": "tag",
            "wrappedExportKey": "wrapped_key",
            "wrappedKeyIv": "wrapped_iv",
            "wrappedKeyTag": "wrapped_tag",
            "senderPublicKey": "sender_public",
            "connectorPublicKey": "connector_public_key_demo",
            "connectorKeyId": "connector_demo",
            "wrappingAlg": "X25519-AES256-GCM",
        },
    )

    assert response.status_code == 500
    assert response.json()["detail"] == "Failed to store encrypted consent export"


def test_approve_consent_does_not_reuse_broken_developer_token(monkeypatch):
    issued = []

    class _FakeConsentDBService:
        async def get_pending_by_request_id(self, user_id: str, request_id: str):
            assert user_id == "user_123"
            assert request_id == "req_strict_reissue"
            return {
                "request_id": request_id,
                "developer": "developer:app_demo_123",
                "scope": "attr.financial.analytics.quality_metrics",
                "metadata": {
                    "request_source": "developer_api_v1",
                    "requester_actor_type": "developer",
                    "connector_public_key": "connector_public_key_demo",
                    "connector_key_id": "connector_demo",
                    "connector_wrapping_alg": "X25519-AES256-GCM",
                },
            }

        async def find_covering_active_token(self, *_args, **_kwargs):
            return {  # noqa: S106
                "token_id": "broken_old_token",
                "scope": "attr.financial.analytics.quality_metrics",
            }

        async def get_consent_export_metadata(self, token_id: str):
            assert token_id == "broken_old_token"  # noqa: S105
            return None

        async def store_consent_export(self, **_kwargs):
            return True

        async def insert_event(self, **_kwargs):
            return 1

        async def get_superseded_active_tokens(self, *_args, **_kwargs):
            return []

    def _issue_token(**_kwargs):
        issued.append(_kwargs)
        return SimpleNamespace(token="fresh_strict_token", expires_at=123456789)  # noqa: S106

    monkeypatch.setattr(consent, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(consent, "issue_token", _issue_token)
    monkeypatch.setattr(
        consent.RIAIAMService,
        "sync_relationship_from_consent_action",
        lambda self, **_kwargs: None,
    )

    client = TestClient(_build_app())
    response = client.post(
        "/api/consent/pending/approve",
        json={
            "userId": "user_123",
            "requestId": "req_strict_reissue",
            "encryptedData": "ciphertext",
            "encryptedIv": "iv",
            "encryptedTag": "tag",
            "wrappedExportKey": "wrapped_key",
            "wrappedKeyIv": "wrapped_iv",
            "wrappedKeyTag": "wrapped_tag",
            "senderPublicKey": "sender_public",
            "connectorPublicKey": "connector_public_key_demo",
            "connectorKeyId": "connector_demo",
            "wrappingAlg": "X25519-AES256-GCM",
        },
    )

    assert response.status_code == 200
    assert response.json()["consent_token"] == "fresh_strict_token"  # noqa: S105
    assert issued, "Expected broken strict export state to force a fresh token issuance"


def test_approve_consent_reused_token_still_syncs_ria_relationship(monkeypatch):
    sync_calls: list[dict] = []

    class _FakeConsentDBService:
        async def get_pending_by_request_id(self, user_id: str, request_id: str):
            assert user_id == "user_123"
            assert request_id == "req_ria_reuse"
            return {
                "request_id": request_id,
                "developer": "ria:profile_demo_123",
                "scope": "attr.financial.*",
                "metadata": {
                    "requester_actor_type": "ria",
                    "requester_entity_id": "profile_demo_123",
                    "request_source": "ria_request_bundle",
                },
            }

        async def find_covering_active_token(self, *_args, **_kwargs):
            return {
                "token_id": "existing_ria_token",  # noqa: S106
                "scope": "attr.financial.*",
                "expires_at": 123456789,
            }

    async def _mock_sync(self, **kwargs):  # noqa: ANN001
        sync_calls.append(kwargs)

    monkeypatch.setattr(consent, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(
        consent.RIAIAMService,
        "sync_relationship_from_consent_action",
        _mock_sync,
    )

    client = TestClient(_build_app())
    response = client.post(
        "/api/consent/pending/approve",
        json={
            "userId": "user_123",
            "requestId": "req_ria_reuse",
        },
    )

    assert response.status_code == 200
    assert response.json()["consent_token"] == "existing_ria_token"  # noqa: S105
    assert sync_calls == [
        {
            "user_id": "user_123",
            "request_id": "req_ria_reuse",
            "action": "CONSENT_GRANTED",
        }
    ]
