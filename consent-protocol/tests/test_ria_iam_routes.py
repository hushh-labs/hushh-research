from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes import consent, iam, invites, marketplace, ria
from hushh_mcp.services.ria_iam_service import (
    IAMSchemaNotReadyError,
    RIAIAMPolicyError,
    RIAIAMService,
)

TEST_INVITE_ID = "invite-demo-id"
TEST_INVITE_VALUE = "invite-demo-value"


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(consent.router)
    app.include_router(iam.router)
    app.include_router(ria.router)
    app.include_router(marketplace.router)
    app.include_router(invites.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "user_test_123"
    return app


def test_iam_persona_returns_actor_state(monkeypatch):
    async def _mock_get_persona_state(self, user_id: str):
        assert user_id == "user_test_123"
        return {
            "user_id": user_id,
            "personas": ["investor", "ria"],
            "last_active_persona": "ria",
            "investor_marketplace_opt_in": True,
        }

    monkeypatch.setattr(RIAIAMService, "get_persona_state", _mock_get_persona_state)

    client = TestClient(_build_app())
    response = client.get("/api/iam/persona")

    assert response.status_code == 200
    payload = response.json()
    assert payload["last_active_persona"] == "ria"
    assert payload["investor_marketplace_opt_in"] is True


def test_iam_persona_schema_not_ready_returns_compat_payload(monkeypatch):
    async def _mock_get_persona_state(self, user_id: str):
        assert user_id == "user_test_123"
        raise IAMSchemaNotReadyError("IAM schema is not ready")

    monkeypatch.setattr(RIAIAMService, "get_persona_state", _mock_get_persona_state)

    client = TestClient(_build_app())
    response = client.get("/api/iam/persona")

    assert response.status_code == 200
    payload = response.json()
    assert payload["user_id"] == "user_test_123"
    assert payload["personas"] == ["investor"]
    assert payload["last_active_persona"] == "investor"
    assert payload["iam_schema_ready"] is False
    assert payload["mode"] == "compat_investor"


def test_ria_request_enforces_verification_policy(monkeypatch):
    async def _mock_require(self, user_id: str):
        raise RIAIAMPolicyError("RIA verification incomplete", status_code=403)

    monkeypatch.setattr(RIAIAMService, "require_ria_verified", _mock_require)

    client = TestClient(_build_app())
    response = client.post(
        "/api/ria/requests",
        json={
            "subject_user_id": "investor_1",
            "requester_actor_type": "ria",
            "subject_actor_type": "investor",
            "scope_template_id": "ria_financial_summary_v1",
            "duration_mode": "preset",
            "duration_hours": 168,
        },
    )

    assert response.status_code == 403
    assert "verification" in response.json()["detail"].lower()


def test_ria_clients_schema_not_ready_returns_503(monkeypatch):
    async def _mock_require(self, user_id: str):
        return

    async def _mock_clients(self, user_id: str):
        assert user_id == "user_test_123"
        raise IAMSchemaNotReadyError("IAM schema is not ready")

    monkeypatch.setattr(RIAIAMService, "require_ria_verified", _mock_require)
    monkeypatch.setattr(RIAIAMService, "list_ria_clients", _mock_clients)

    client = TestClient(_build_app())
    response = client.get("/api/ria/clients")

    assert response.status_code == 503
    payload = response.json()
    assert payload["code"] == "IAM_SCHEMA_NOT_READY"


def test_marketplace_rias_public_read(monkeypatch):
    async def _mock_search(self, **kwargs):  # noqa: ANN003
        assert kwargs.get("limit") == 20
        return [
            {
                "id": "ria_1",
                "display_name": "RIA Alpha",
                "verification_status": "verified",
            }
        ]

    monkeypatch.setattr(RIAIAMService, "search_marketplace_rias", _mock_search)

    client = TestClient(_build_app())
    response = client.get("/api/marketplace/rias")

    assert response.status_code == 200
    data = response.json()
    assert len(data["items"]) == 1
    assert data["items"][0]["display_name"] == "RIA Alpha"


def test_ria_onboarding_submit_maps_professional_capabilities(monkeypatch):
    async def _mock_submit(self, user_id: str, **kwargs):  # noqa: ANN003
        assert user_id == "user_test_123"
        assert kwargs["requested_capabilities"] == ["advisory", "brokerage"]
        assert kwargs["individual_legal_name"] == "Advisor Alpha"
        assert kwargs["individual_crd"] == "12345"
        assert kwargs["advisory_firm_legal_name"] == "Advisor Alpha LLC"
        assert kwargs["advisory_firm_iapd_number"] == "801-12345"
        assert kwargs["broker_firm_legal_name"] == "Broker Alpha LLC"
        assert kwargs["broker_firm_crd"] == "56789"
        return {
            "ria_profile_id": "ria_profile_1",
            "verification_status": "verified",
            "advisory_status": "verified",
            "brokerage_status": "submitted",
            "requested_capabilities": ["advisory", "brokerage"],
            "verification_outcome": "verified",
            "verification_message": "Advisory verification successful",
            "brokerage_outcome": "evidence_only",
            "brokerage_message": "Broker capability is awaiting official verification configuration",
            "professional_access_granted": True,
        }

    monkeypatch.setattr(RIAIAMService, "submit_ria_onboarding", _mock_submit)

    client = TestClient(_build_app())
    response = client.post(
        "/api/ria/onboarding/submit",
        json={
            "display_name": "Advisor Alpha",
            "requested_capabilities": ["advisory", "brokerage"],
            "individual_legal_name": "Advisor Alpha",
            "individual_crd": "12345",
            "advisory_firm_legal_name": "Advisor Alpha LLC",
            "advisory_firm_iapd_number": "801-12345",
            "broker_firm_legal_name": "Broker Alpha LLC",
            "broker_firm_crd": "56789",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["advisory_status"] == "verified"
    assert payload["brokerage_status"] == "submitted"
    assert payload["requested_capabilities"] == ["advisory", "brokerage"]


def test_ria_name_verification_route_maps_stage1_lookup(monkeypatch):
    async def _mock_verify_name(self, query: str, crd_number: str | None = None):
        assert query == "Ana Roumenova Carter"
        assert crd_number == "4424794"
        return {
            "status": "verified",
            "matched_name": "Ana Roumenova Carter",
            "crd_number": "4424794",
            "current_firm": "LCG CAPITAL ADVISORS, LLC",
            "sec_number": "801-12345",
            "reason": None,
            "suggested_names": [],
            "provider": "ria_intelligence_stage1",
        }

    monkeypatch.setattr(RIAIAMService, "verify_ria_name", _mock_verify_name)

    client = TestClient(_build_app())
    response = client.post(
        "/api/ria/onboarding/verify-name",
        json={"query": "Ana Roumenova Carter", "crd_number": "4424794"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "verified"
    assert payload["crd_number"] == "4424794"
    assert payload["provider"] == "ria_intelligence_stage1"


def test_marketplace_schema_not_ready_returns_503(monkeypatch):
    async def _mock_search(self, **kwargs):  # noqa: ANN003
        _ = kwargs
        raise IAMSchemaNotReadyError("IAM schema is not ready")

    monkeypatch.setattr(RIAIAMService, "search_marketplace_rias", _mock_search)

    client = TestClient(_build_app())
    response = client.get("/api/marketplace/rias")

    assert response.status_code == 503
    payload = response.json()
    assert payload["code"] == "IAM_SCHEMA_NOT_READY"


def test_ria_picks_returns_only_active_package(monkeypatch):
    async def _mock_get(self, user_id: str):
        assert user_id == "user_test_123"
        return {
            "package": {
                "top_picks": [{"ticker": "NVDA", "tier": "ACE"}],
                "avoid_rows": [],
                "screening_sections": [
                    {"section": "investable_requirements", "rows": []},
                    {"section": "automatic_avoid_triggers", "rows": []},
                    {"section": "the_math", "rows": []},
                ],
                "package_note": None,
            },
            "metadata": {
                "has_package": True,
                "storage_source": "legacy",
                "package_revision": 0,
                "top_pick_count": 1,
                "avoid_count": 0,
                "screening_row_count": 0,
                "active_share_count": 1,
            },
        }

    monkeypatch.setattr(RIAIAMService, "get_active_ria_pick_package", _mock_get)

    client = TestClient(_build_app())
    response = client.get("/api/ria/picks")

    assert response.status_code == 200
    payload = response.json()
    assert list(payload.keys()) == ["package", "metadata"]
    assert payload["package"]["top_picks"][0]["ticker"] == "NVDA"
    assert payload["metadata"]["storage_source"] == "legacy"


def test_ria_picks_post_syncs_share_artifacts(monkeypatch):
    async def _mock_sync(self, user_id: str, **kwargs):  # noqa: ANN003
        assert user_id == "user_test_123"
        assert kwargs["source_data_version"] == 7
        return {
            "status": "synced",
            "share_artifacts_updated": 2,
            "retired_legacy": True,
            "package": {
                "top_picks": [{"ticker": "NVDA", "tier": "ACE"}],
                "avoid_rows": [],
                "screening_sections": [],
                "package_note": None,
            },
        }

    monkeypatch.setattr(RIAIAMService, "sync_ria_pick_share_artifacts", _mock_sync)

    client = TestClient(_build_app())
    response = client.post(
        "/api/ria/picks",
        json={
            "top_picks": [{"ticker": "NVDA", "tier": "ACE"}],
            "avoid_rows": [],
            "screening_sections": [],
            "source_data_version": 7,
        },
    )

    assert response.status_code == 200
    assert response.json()["status"] == "synced"


def test_ria_picks_parse_requires_csv(monkeypatch):
    async def _mock_parse(self, **kwargs):  # noqa: ANN003
        raise AssertionError("parse_ria_pick_csv should not be called when csv_content is missing")

    monkeypatch.setattr(RIAIAMService, "parse_ria_pick_csv", _mock_parse)

    client = TestClient(_build_app())
    response = client.post("/api/ria/picks/parse", json={})

    assert response.status_code == 422


def test_ria_client_picks_share_toggle(monkeypatch):
    async def _mock_require(self, user_id: str):
        return

    async def _mock_toggle(self, user_id: str, *, investor_user_id: str, enabled: bool):
        assert user_id == "user_test_123"
        assert investor_user_id == "investor_1"
        assert enabled is False
        return {"enabled": False, "status": "revoked", "grant_key": "ria_active_picks_feed_v1"}

    monkeypatch.setattr(RIAIAMService, "require_ria_verified", _mock_require)
    monkeypatch.setattr(RIAIAMService, "set_ria_pick_share_state", _mock_toggle)

    client = TestClient(_build_app())
    response = client.post("/api/ria/clients/investor_1/picks-share", json={"enabled": False})

    assert response.status_code == 200
    assert response.json()["status"] == "revoked"


def test_ria_home_omits_pick_history_fields(monkeypatch):
    async def _mock_home(self, user_id: str):
        assert user_id == "user_test_123"
        return {
            "onboarding": {"exists": True, "verification_status": "verified"},
            "verification_status": "verified",
            "primary_action": {
                "label": "Open clients",
                "href": "/ria/clients",
                "description": "Relationships and requests are ready to manage.",
            },
            "counts": {"active_clients": 1, "needs_attention": 0, "invites": 0},
            "needs_attention": [],
            "active_picks": {"status": "ready", "active_rows": 12},
        }

    monkeypatch.setattr(RIAIAMService, "get_ria_home", _mock_home)

    client = TestClient(_build_app())
    response = client.get("/api/ria/home")

    assert response.status_code == 200
    payload = response.json()
    assert payload["active_picks"] == {"status": "ready", "active_rows": 12}


def test_ria_invites_create(monkeypatch):
    async def _mock_require(self, user_id: str):
        return

    async def _mock_create(self, user_id: str, **kwargs):  # noqa: ANN003
        assert user_id == "user_test_123"
        assert kwargs["scope_template_id"] == "ria_financial_summary_v1"
        return {
            "items": [
                {
                    "invite_id": "invite_1",
                    "invite_token": TEST_INVITE_VALUE,
                    "status": "sent",
                }
            ]
        }

    monkeypatch.setattr(RIAIAMService, "require_ria_verified", _mock_require)
    monkeypatch.setattr(RIAIAMService, "create_ria_invites", _mock_create)

    client = TestClient(_build_app())
    response = client.post(
        "/api/ria/invites",
        json={
            "scope_template_id": "ria_financial_summary_v1",
            "duration_mode": "preset",
            "duration_hours": 168,
            "targets": [{"display_name": "Taylor", "email": "taylor@example.com"}],
        },
    )

    assert response.status_code == 200
    assert response.json()["items"][0]["invite_token"] == TEST_INVITE_VALUE


def test_public_invite_lookup(monkeypatch):
    async def _mock_get(self, invite_token: str):
        assert invite_token == TEST_INVITE_VALUE
        return {
            "invite_token": invite_token,
            "status": "sent",
            "ria": {"display_name": "RIA Alpha"},
        }

    monkeypatch.setattr(RIAIAMService, "get_ria_invite", _mock_get)

    client = TestClient(_build_app())
    response = client.get(f"/api/invites/{TEST_INVITE_VALUE}")

    assert response.status_code == 200
    assert response.json()["ria"]["display_name"] == "RIA Alpha"


def test_accept_invite(monkeypatch):
    async def _mock_accept(self, invite_token: str, user_id: str):
        assert invite_token == TEST_INVITE_VALUE
        assert user_id == "user_test_123"
        return {
            "invite_token": invite_token,
            "request_id": "req_1",
            "status": "accepted",
        }

    monkeypatch.setattr(RIAIAMService, "accept_ria_invite", _mock_accept)

    client = TestClient(_build_app())
    response = client.post(f"/api/invites/{TEST_INVITE_VALUE}/accept")

    assert response.status_code == 200
    assert response.json()["request_id"] == "req_1"


def test_consent_center_returns_combined_surface(monkeypatch):
    async def _mock_center(self, user_id: str):
        assert user_id == "user_test_123"
        return {
            "user_id": user_id,
            "persona_state": {"last_active_persona": "investor"},
            "summary": {"incoming_requests": 1},
            "incoming_requests": [{"id": "req_1", "kind": "incoming_request"}],
            "outgoing_requests": [],
            "active_grants": [],
            "history": [],
            "invites": [],
            "developer_requests": [],
        }

    from hushh_mcp.services.consent_center_service import ConsentCenterService

    monkeypatch.setattr(ConsentCenterService, "get_center", _mock_center)

    client = TestClient(_build_app())
    response = client.get("/api/consent/center")

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["incoming_requests"] == 1
    assert payload["incoming_requests"][0]["kind"] == "incoming_request"


def test_consent_center_summary_route_returns_actor_counts(monkeypatch):
    async def _mock_summary(self, user_id: str, *, actor: str, mode: str = "consents"):
        assert user_id == "user_test_123"
        assert actor == "ria"
        return {
            "user_id": user_id,
            "actor": actor,
            "counts": {
                "pending": 3,
                "active": 4,
                "previous": 5,
            },
        }

    from hushh_mcp.services.consent_center_service import ConsentCenterService

    monkeypatch.setattr(ConsentCenterService, "get_center_summary", _mock_summary)

    client = TestClient(_build_app())
    response = client.get("/api/consent/center/summary?actor=ria")

    assert response.status_code == 200
    payload = response.json()
    assert payload["actor"] == "ria"
    assert payload["counts"] == {"pending": 3, "active": 4, "previous": 5}


def test_consent_center_list_route_returns_page_contract(monkeypatch):
    async def _mock_list(
        self,
        user_id: str,
        *,
        actor: str,
        surface: str,
        mode: str = "consents",
        query: str | None = None,
        top: int | None = None,
        page: int = 1,
        limit: int = 20,
    ):
        assert user_id == "user_test_123"
        assert actor == "investor"
        assert surface == "pending"
        assert query == "kai"
        assert top is None
        assert page == 2
        assert limit == 20
        return {
            "user_id": user_id,
            "actor": actor,
            "surface": surface,
            "query": query,
            "page": page,
            "limit": limit,
            "total": 21,
            "has_more": False,
            "items": [{"id": "req_1", "kind": "incoming_request"}],
        }

    from hushh_mcp.services.consent_center_service import ConsentCenterService

    monkeypatch.setattr(ConsentCenterService, "list_center", _mock_list)

    client = TestClient(_build_app())
    response = client.get(
        "/api/consent/center/list?actor=investor&surface=pending&q=kai&page=2&limit=20"
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["page"] == 2
    assert payload["limit"] == 20
    assert payload["total"] == 21
    assert payload["items"][0]["kind"] == "incoming_request"


def test_consent_center_list_route_supports_top_preview(monkeypatch):
    async def _mock_list(
        self,
        user_id: str,
        *,
        actor: str,
        surface: str,
        mode: str = "consents",
        query: str | None = None,
        top: int | None = None,
        page: int = 1,
        limit: int = 20,
    ):
        assert user_id == "user_test_123"
        assert actor == "ria"
        assert surface == "pending"
        assert query is None
        assert top == 5
        assert page == 1
        assert limit == 20
        return {
            "user_id": user_id,
            "actor": actor,
            "surface": surface,
            "query": "",
            "page": 1,
            "limit": 5,
            "total": 7,
            "has_more": True,
            "items": [{"id": "invite_1", "kind": "invite"}],
        }

    from hushh_mcp.services.consent_center_service import ConsentCenterService

    monkeypatch.setattr(ConsentCenterService, "list_center", _mock_list)

    client = TestClient(_build_app())
    response = client.get("/api/consent/center/list?actor=ria&surface=pending&top=5")

    assert response.status_code == 200
    payload = response.json()
    assert payload["limit"] == 5
    assert payload["total"] == 7
    assert payload["has_more"] is True
    assert payload["items"][0]["kind"] == "invite"


def test_generic_consent_request_routes_to_ria_request_creation(monkeypatch):
    async def _mock_require(self, user_id: str):
        return

    async def _mock_create(self, user_id: str, **kwargs):  # noqa: ANN003
        assert user_id == "user_test_123"
        assert kwargs["scope_template_id"] == "ria_financial_summary_v1"
        return {"request_id": "req_generic_1", "status": "REQUESTED"}

    monkeypatch.setattr(RIAIAMService, "require_ria_verified", _mock_require)
    monkeypatch.setattr(RIAIAMService, "create_ria_consent_request", _mock_create)

    client = TestClient(_build_app())
    response = client.post(
        "/api/consent/requests",
        json={
            "subject_user_id": "investor_1",
            "requester_actor_type": "ria",
            "subject_actor_type": "investor",
            "scope_template_id": "ria_financial_summary_v1",
            "duration_mode": "preset",
            "duration_hours": 168,
        },
    )

    assert response.status_code == 200
    assert response.json()["request_id"] == "req_generic_1"


def test_ria_client_detail_route_exposes_relationship_share_fields(monkeypatch):
    async def _mock_require(self, user_id: str):
        return

    monkeypatch.setattr(RIAIAMService, "require_ria_verified", _mock_require)

    async def _mock_detail(self, user_id: str, investor_user_id: str):
        assert user_id == "user_test_123"
        assert investor_user_id == "investor_1"
        return {
            "investor_user_id": investor_user_id,
            "investor_display_name": "Taylor",
            "relationship_status": "approved",
            "granted_scope": "attr.financial.*",
            "disconnect_allowed": True,
            "is_self_relationship": False,
            "next_action": "open_workspace",
            "relationship_shares": [
                {
                    "grant_key": "ria_active_picks_feed_v1",
                    "label": "Advisor picks feed",
                    "description": "Included with the advisor relationship.",
                    "status": "active",
                    "share_origin": "relationship_implicit",
                }
            ],
            "picks_feed_status": "ready",
            "picks_feed_granted_at": "2026-03-24T00:00:00Z",
            "has_active_pick_upload": True,
            "granted_scopes": [],
            "request_history": [],
            "invite_history": [],
            "requestable_scope_templates": [],
            "available_scope_metadata": [],
            "available_domains": [],
            "domain_summaries": {},
            "total_attributes": 0,
            "workspace_ready": False,
            "pkm_updated_at": None,
        }

    monkeypatch.setattr(RIAIAMService, "get_ria_client_detail", _mock_detail)

    client = TestClient(_build_app())
    response = client.get("/api/ria/clients/investor_1")

    assert response.status_code == 200
    payload = response.json()
    assert payload["picks_feed_status"] == "ready"
    assert payload["has_active_pick_upload"] is True
    assert payload["relationship_shares"][0]["grant_key"] == "ria_active_picks_feed_v1"
