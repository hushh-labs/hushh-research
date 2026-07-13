from __future__ import annotations

from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import pkm, pkm_routes_shared


def _confirmed_mutation_plan_payload(
    *,
    recipient_labels: list[str] | None = None,
    affected_grant_ids: list[str] | None = None,
    affected_export_ids: list[str] | None = None,
) -> dict:
    labels = recipient_labels or []
    plan_id = "pkm_plan_route_test_001"
    return {
        "version": 2,
        "plan_id": plan_id,
        "operation": "create",
        "target_scope_handle": "pending_scope_route_001",
        "proposed_domain": "financial",
        "proposed_scope": "portfolio",
        "friendly_domain_name": "Financial",
        "friendly_scope_name": "Portfolio",
        "confidence": 1.0,
        "explanation": "The owner reviewed this encrypted PKM write.",
        "affected_grant_ids": affected_grant_ids or [],
        "affected_export_ids": affected_export_ids or [],
        "sharing_impact": {
            "active_recipient_count": len(labels),
            "recipient_labels": labels,
            "enters_next_export_revision": bool(labels),
            "summary": (
                "This change affects approved recipients."
                if labels
                else "No active recipients are affected."
            ),
        },
        "confirmation_receipt": {
            "version": 2,
            "receipt_id": "pkm_receipt_route_test_001",
            "plan_id": plan_id,
            "confirmed_by_user_id": "user_123",
            "confirmed_at": datetime.now(timezone.utc).isoformat(),
            "surface": "web",
            "displayed_domain": "financial",
            "displayed_scope": "portfolio",
            "sharing_impact_acknowledged": bool(labels),
        },
    }


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(pkm_routes_shared.router)
    app.dependency_overrides[pkm_routes_shared.require_vault_owner_token] = lambda: {
        "user_id": "user_123"
    }
    return app


def test_store_domain_forwards_upgrade_context(monkeypatch):
    captured: dict[str, object] = {}

    class _FakePkmService:
        async def store_domain_data(self, **kwargs):
            captured.update(kwargs)
            return {
                "success": True,
                "data_version": 4,
                "updated_at": "2026-03-24T12:00:00Z",
            }

    monkeypatch.setattr(pkm_routes_shared, "get_pkm_service", lambda: _FakePkmService())

    client = TestClient(_build_app())
    response = client.post(
        "/api/pkm/store-domain",
        json={
            "user_id": "user_123",
            "domain": "financial",
            "encrypted_blob": {
                "ciphertext": "cipher",
                "iv": "iv",
                "tag": "tag",
                "algorithm": "aes-256-gcm",
            },
            "summary": {"holdings_count": 2},
            "upgrade_context": {
                "run_id": "pkm_upgrade_demo",
                "prior_domain_contract_version": 1,
                "new_domain_contract_version": 2,
                "prior_readable_summary_version": 0,
                "new_readable_summary_version": 1,
                "retry_count": 0,
            },
            "write_projections": [
                {
                    "projection_type": "decision_history_v1",
                    "projection_version": 1,
                    "payload": {"decisions": []},
                }
            ],
        },
    )

    assert response.status_code == 200
    assert captured["upgrade_context"] == {
        "run_id": "pkm_upgrade_demo",
        "prior_domain_contract_version": 1,
        "new_domain_contract_version": 2,
        "prior_readable_summary_version": 0,
        "new_readable_summary_version": 1,
        "retry_count": 0,
    }
    assert captured["write_projections"] == [
        {
            "projection_type": "decision_history_v1",
            "projection_version": 1,
            "payload": {"decisions": []},
        }
    ]


def test_store_domain_rejects_stale_sharing_impact(monkeypatch):
    class _FakePkmService:
        async def get_mutation_sharing_impact(self, **_kwargs):
            return {
                "active_recipient_count": 1,
                "recipient_labels": ["Hushh Technologies"],
                "enters_next_export_revision": True,
                "summary": "This change affects Hushh Technologies.",
                "affected_grant_ids": ["grant_current"],
                "affected_export_ids": ["grant_current:revision:4"],
            }

        async def store_domain_data(self, **_kwargs):
            raise AssertionError("A stale confirmation must never reach storage")

    monkeypatch.setattr(pkm_routes_shared, "get_pkm_service", lambda: _FakePkmService())

    client = TestClient(_build_app())
    response = client.post(
        "/api/pkm/store-domain",
        json={
            "user_id": "user_123",
            "domain": "financial",
            "encrypted_blob": {
                "ciphertext": "cipher",
                "iv": "iv",
                "tag": "tag",
                "algorithm": "aes-256-gcm",
            },
            "summary": {"holdings_count": 2},
            "mutation_plan": _confirmed_mutation_plan_payload(),
        },
    )

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "PKM_SHARING_IMPACT_CHANGED"
    assert detail["sharing_impact"]["recipient_labels"] == ["Hushh Technologies"]


def test_agent_lab_preview_is_enriched_with_current_sharing_impact(monkeypatch):
    class _FakeAgentLabService:
        async def generate_structure_preview(self, **_kwargs):
            return {
                "agent_id": "pkm_structure",
                "agent_name": "PKM Structure",
                "model": "deterministic-test",
                "used_fallback": False,
                "candidate_payload": {"portfolio": {"ticker": "AAPL"}},
                "structure_decision": {
                    "action": "create_domain",
                    "target_domain": "financial",
                },
                "write_mode": "confirm_first",
                "preview_cards": [
                    {
                        "write_mode": "confirm_first",
                        "target_domain": "financial",
                        "primary_json_path": "portfolio.holdings",
                        "manifest_draft": {
                            "domain": "financial",
                            "top_level_scope_paths": ["portfolio"],
                        },
                    }
                ],
                "preview_summary": {"card_count": 1},
            }

    class _FakePkmService:
        async def get_mutation_sharing_impact(self, **kwargs):
            assert kwargs == {
                "user_id": "user_123",
                "domain": "financial",
                "scope_path": "portfolio",
            }
            return {
                "active_recipient_count": 1,
                "recipient_labels": ["Hushh Technologies"],
                "enters_next_export_revision": True,
                "summary": "This change affects Hushh Technologies.",
                "affected_grant_ids": ["grant_current"],
                "affected_export_ids": ["grant_current:revision:4"],
            }

    app = FastAPI()
    app.include_router(pkm.router)
    app.dependency_overrides[pkm.require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(pkm, "get_pkm_agent_lab_service", lambda: _FakeAgentLabService())
    monkeypatch.setattr(pkm, "get_pkm_service", lambda: _FakePkmService())

    response = TestClient(app).post(
        "/api/pkm/agent-lab/structure",
        json={"user_id": "user_123", "message": "Save AAPL in my portfolio"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["preview_summary"]["active_recipient_count"] == 1
    assert payload["preview_cards"][0]["sharing_impact"]["recipient_labels"] == [
        "Hushh Technologies"
    ]


def test_scope_exposure_route_forwards_payload(monkeypatch):
    captured: dict[str, object] = {}

    class _FakePkmService:
        async def update_scope_exposure(self, **kwargs):
            captured.update(kwargs)
            return {
                "success": True,
                "message": "Updated PKM scope exposure.",
                "manifest_version": 5,
                "revoked_grant_count": 2,
                "revoked_grant_ids": ["token_a", "token_b"],
                "manifest": {"domain": "financial", "manifest_version": 5},
            }

    monkeypatch.setattr(pkm_routes_shared, "get_pkm_service", lambda: _FakePkmService())

    client = TestClient(_build_app())
    response = client.post(
        "/api/pkm/domains/financial/scope-exposure",
        json={
            "user_id": "user_123",
            "expected_manifest_version": 4,
            "revoke_matching_active_grants": True,
            "changes": [
                {
                    "scope_handle": "s_demo",
                    "top_level_scope_path": "portfolio",
                    "exposure_enabled": False,
                }
            ],
        },
    )

    assert response.status_code == 200
    assert captured == {
        "user_id": "user_123",
        "domain": "financial",
        "expected_manifest_version": 4,
        "changes": [
            {
                "scope_handle": "s_demo",
                "top_level_scope_path": "portfolio",
                "exposure_enabled": False,
                "visibility_posture": None,
                "owner_consent_override": None,
            }
        ],
        "revoke_matching_active_grants": True,
    }


def test_manifest_route_serializes_datetime_fields(monkeypatch):
    upgraded = datetime(2026, 3, 28, 17, 45, 0, tzinfo=timezone.utc)
    structured = datetime(2026, 3, 28, 17, 46, 0, tzinfo=timezone.utc)
    content = datetime(2026, 3, 28, 17, 47, 0, tzinfo=timezone.utc)

    class _FakePkmService:
        async def get_domain_manifest(self, user_id: str, domain: str):
            assert user_id == "user_123"
            assert domain == "financial"
            return {
                "user_id": user_id,
                "domain": domain,
                "manifest_version": 3,
                "domain_contract_version": 2,
                "readable_summary_version": 1,
                "upgraded_at": upgraded,
                "structure_decision": {},
                "summary_projection": {},
                "top_level_scope_paths": [],
                "externalizable_paths": [],
                "path_count": 0,
                "externalizable_path_count": 0,
                "segment_ids": [],
                "last_structured_at": structured,
                "last_content_at": content,
                "paths": [],
                "scope_registry": [],
            }

    monkeypatch.setattr(pkm_routes_shared, "get_pkm_service", lambda: _FakePkmService())

    client = TestClient(_build_app())
    response = client.get("/api/pkm/manifest/user_123/financial")

    assert response.status_code == 200
    payload = response.json()
    assert payload["upgraded_at"] == upgraded.isoformat()
    assert payload["last_structured_at"] == structured.isoformat()
    assert payload["last_content_at"] == content.isoformat()


def test_upgrade_status_route_serializes_run_and_steps(monkeypatch):
    class _FakeUpgradeService:
        async def build_status(self, user_id: str):
            assert user_id == "user_123"
            return {
                "user_id": "user_123",
                "model_version": 3,
                "stored_model_version": 2,
                "effective_model_version": 3,
                "target_model_version": 3,
                "upgrade_status": "running",
                "last_upgraded_at": "2026-03-20T12:00:00Z",
                "upgradable_domains": [
                    {
                        "domain": "financial",
                        "current_domain_contract_version": 1,
                        "target_domain_contract_version": 2,
                        "current_readable_summary_version": 0,
                        "target_readable_summary_version": 1,
                        "upgraded_at": None,
                        "needs_upgrade": True,
                    }
                ],
                "run": {
                    "run_id": "pkm_upgrade_demo",
                    "user_id": "user_123",
                    "status": "running",
                    "from_model_version": 2,
                    "to_model_version": 3,
                    "current_domain": "financial",
                    "initiated_by": "unlock_warm",
                    "resume_count": 0,
                    "started_at": "2026-03-24T12:00:00Z",
                    "last_checkpoint_at": "2026-03-24T12:05:00Z",
                    "completed_at": None,
                    "last_error": None,
                    "mode": "real",
                    "error_context": {
                        "stage": "loading_manifest",
                        "domain": "financial",
                        "http_status": 500,
                        "detail": "Manifest read failed",
                        "correlation_id": "corr_123",
                    },
                    "created_at": "2026-03-24T12:00:00Z",
                    "updated_at": "2026-03-24T12:05:00Z",
                    "steps": [
                        {
                            "run_id": "pkm_upgrade_demo",
                            "domain": "financial",
                            "status": "running",
                            "from_domain_contract_version": 1,
                            "to_domain_contract_version": 2,
                            "from_readable_summary_version": 0,
                            "to_readable_summary_version": 1,
                            "attempt_count": 1,
                            "last_completed_content_revision": None,
                            "last_completed_manifest_version": None,
                            "checkpoint_payload": {"stage": "loading_domain"},
                            "created_at": "2026-03-24T12:00:00Z",
                            "updated_at": "2026-03-24T12:05:00Z",
                        }
                    ],
                },
            }

    monkeypatch.setattr(pkm_routes_shared, "get_pkm_upgrade_service", lambda: _FakeUpgradeService())

    client = TestClient(_build_app())
    response = client.get("/api/pkm/upgrade/status/user_123")

    assert response.status_code == 200
    payload = response.json()
    assert payload["model_version"] == 3
    assert payload["stored_model_version"] == 2
    assert payload["effective_model_version"] == 3
    assert payload["target_model_version"] == 3
    assert payload["upgrade_status"] == "running"
    assert payload["upgradable_domains"][0]["domain"] == "financial"
    assert payload["run"]["run_id"] == "pkm_upgrade_demo"
    assert payload["run"]["mode"] == "real"
    assert payload["run"]["error_context"]["correlation_id"] == "corr_123"
    assert payload["run"]["steps"][0]["checkpoint_payload"]["stage"] == "loading_domain"


def test_manifest_route_serializes_legacy_manifest_payload(monkeypatch):
    class _FakePkmService:
        async def get_domain_manifest(self, user_id: str, domain: str):
            assert user_id == "user_123"
            assert domain == "financial"
            return {
                "user_id": "user_123",
                "domain": "financial",
                "manifest_version": "2",
                "domain_contract_version": "2",
                "readable_summary_version": "1",
                "structure_decision": '{"action":"extend_domain","target_domain":"financial"}',
                "summary_projection": '{"readable_summary":"Updated"}',
                "top_level_scope_paths": '["portfolio","profile"]',
                "externalizable_paths": '["portfolio.entities.demo"]',
                "segment_ids": '["root"]',
                "paths": '[{"json_path":"portfolio.entities.demo","path_type":"leaf"}]',
                "scope_registry": '[{"scope_handle":"s_demo","top_level_scope_path":"portfolio"}]',
                "last_structured_at": "2026-03-30T10:00:00Z",
                "last_content_at": "2026-03-30T10:00:00Z",
            }

    monkeypatch.setattr(pkm_routes_shared, "get_pkm_service", lambda: _FakePkmService())

    client = TestClient(_build_app())
    response = client.get("/api/pkm/manifest/user_123/financial")

    assert response.status_code == 200
    payload = response.json()
    assert payload["manifest_version"] == 2
    assert payload["domain_contract_version"] == 2
    assert payload["structure_decision"]["action"] == "extend_domain"
    assert payload["summary_projection"]["readable_summary"] == "Updated"
    assert payload["top_level_scope_paths"] == ["portfolio", "profile"]
    assert payload["paths"][0]["json_path"] == "portfolio.entities.demo"
    assert payload["scope_registry"][0]["scope_handle"] == "s_demo"


def test_manifest_route_serializes_datetime_upgraded_at(monkeypatch):
    class _FakePkmService:
        async def get_domain_manifest(self, user_id: str, domain: str):
            return {
                "user_id": user_id,
                "domain": domain,
                "manifest_version": 2,
                "domain_contract_version": 2,
                "readable_summary_version": 1,
                "upgraded_at": datetime(2026, 3, 30, 10, 0, tzinfo=timezone.utc),
                "summary_projection": {},
                "paths": [],
            }

    monkeypatch.setattr(pkm_routes_shared, "get_pkm_service", lambda: _FakePkmService())

    client = TestClient(_build_app())
    response = client.get("/api/pkm/manifest/user_123/financial")

    assert response.status_code == 200
    payload = response.json()
    assert payload["upgraded_at"] == "2026-03-30T10:00:00+00:00"


def test_manifest_route_returns_404_when_manifest_missing(monkeypatch):
    class _FakePkmService:
        async def get_domain_manifest(self, user_id: str, domain: str):
            assert user_id == "user_123"
            assert domain == "financial"
            return None

    monkeypatch.setattr(pkm_routes_shared, "get_pkm_service", lambda: _FakePkmService())

    client = TestClient(_build_app())
    response = client.get("/api/pkm/manifest/user_123/financial")

    assert response.status_code == 404
    assert response.json()["detail"] == "No manifest found for financial"


def test_manifest_route_recovers_from_partially_malformed_legacy_fields(monkeypatch):
    class _FakePkmService:
        async def get_domain_manifest(self, user_id: str, domain: str):
            return {
                "user_id": user_id,
                "domain": domain,
                "manifest_version": "bad",
                "domain_contract_version": None,
                "readable_summary_version": "nan",
                "structure_decision": "{not-json",
                "summary_projection": None,
                "top_level_scope_paths": "not-a-list",
                "externalizable_paths": None,
                "segment_ids": None,
                "paths": "{not-json",
                "scope_registry": None,
            }

    monkeypatch.setattr(pkm_routes_shared, "get_pkm_service", lambda: _FakePkmService())

    client = TestClient(_build_app())
    response = client.get("/api/pkm/manifest/user_123/financial")

    assert response.status_code == 200
    payload = response.json()
    assert payload["manifest_version"] == 1
    assert payload["domain_contract_version"] == 1
    assert payload["readable_summary_version"] == 0
    assert payload["structure_decision"] == {}
    assert payload["summary_projection"] == {}
    assert payload["top_level_scope_paths"] == []
    assert payload["paths"] == []
    assert payload["scope_registry"] == []


def test_validate_store_domain_route_accepts_payload_without_writing(monkeypatch):
    client = TestClient(_build_app())
    response = client.post(
        "/api/pkm/store-domain/validate",
        json={
            "user_id": "user_123",
            "domain": "financial",
            "encrypted_blob": {
                "ciphertext": "cipher",
                "iv": "iv",
                "tag": "tag",
                "algorithm": "aes-256-gcm",
            },
            "summary": {"holdings_count": 1},
            "manifest": {
                "domain": "financial",
                "manifest_version": 2,
                "domain_contract_version": 2,
                "readable_summary_version": 1,
                "summary_projection": {"readable_summary": "Updated"},
                "top_level_scope_paths": ["portfolio"],
                "externalizable_paths": ["portfolio.entities.demo"],
                "paths": [],
            },
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert "without saving it" in payload["message"]


def test_canonical_pkm_router_exposes_upgrade_status(monkeypatch):
    class _FakeUpgradeService:
        async def build_status(self, user_id: str):
            assert user_id == "user_123"
            return {
                "user_id": "user_123",
                "model_version": 1,
                "stored_model_version": 1,
                "effective_model_version": 1,
                "target_model_version": 1,
                "upgrade_status": "current",
                "upgradable_domains": [],
                "last_upgraded_at": None,
                "run": None,
            }

    app = FastAPI()
    app.include_router(pkm.router)
    app.dependency_overrides[pkm.require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(pkm, "_get_upgrade_status", pkm_routes_shared.get_upgrade_status)
    monkeypatch.setattr(pkm_routes_shared, "get_pkm_upgrade_service", lambda: _FakeUpgradeService())

    client = TestClient(app)
    response = client.get("/api/pkm/upgrade/status/user_123")

    assert response.status_code == 200
    payload = response.json()
    assert payload["user_id"] == "user_123"
    assert payload["upgrade_status"] == "current"


def test_canonical_pkm_router_exposes_validate_store_domain(monkeypatch):
    app = FastAPI()
    app.include_router(pkm.router)
    app.dependency_overrides[pkm.require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(pkm, "_validate_store_domain", pkm_routes_shared.validate_store_domain)

    client = TestClient(app)
    response = client.post(
        "/api/pkm/store-domain/validate",
        json={
            "user_id": "user_123",
            "domain": "financial",
            "encrypted_blob": {
                "ciphertext": "cipher",
                "iv": "iv",
                "tag": "tag",
                "algorithm": "aes-256-gcm",
            },
            "summary": {"holdings_count": 1},
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert "without saving it" in payload["message"]
